package win.naebka.live;

import com.fasterxml.jackson.databind.JsonNode;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.time.Instant;
import java.util.Optional;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import win.naebka.common.Exceptions.ExternalScraperUnavailableException;
import win.naebka.common.Json;

/**
 * Fetches the official post-match report from a deadlock-api-shaped endpoint (GET /v1/matches/{id}/metadata):
 * the public Deadlock API, or the team's Steam bot in {@code serve} mode, which answers with the same JSON.
 *
 * <p>Each source has its own circuit breaker (LLD: ExternalScraperUnavailableException). A "too many requests"
 * (429) or "service unavailable" (503) answer opens it at once for as long as the {@code Retry-After} header says
 * (60 s without one); 3 other failures in a row open it for 60 s. {@link FallbackReportSource} decides which
 * source to ask.
 */
public class DeadlockReportClient {
    private static final Logger log = LoggerFactory.getLogger(DeadlockReportClient.class);
    private static final int FAILURE_THRESHOLD = 3;
    private static final Duration OPEN_FOR = Duration.ofSeconds(60);
    private static final long MAX_RETRY_AFTER_S = 900;

    public enum BreakerState { CLOSED, OPEN, HALF_OPEN }

    /** The source can't be asked right now; {@link #retryAfterSeconds()} says when to try again. */
    public static class Unavailable extends ExternalScraperUnavailableException {
        private final long retryAfterSeconds;

        public Unavailable(String message, long retryAfterSeconds) {
            super(message);
            this.retryAfterSeconds = Math.max(1, retryAfterSeconds);
        }

        public long retryAfterSeconds() {
            return retryAfterSeconds;
        }
    }

    private final String name;
    private final String baseUrl;
    private final String token;
    private final Duration timeout;
    private final HttpClient http;
    private int consecutiveFailures;
    private Instant openUntil;

    /** {@code token}: sent as {@code Authorization: Bearer} when not blank (the bot's DEADLOCK_BOT_TOKEN). */
    public DeadlockReportClient(String name, String baseUrl, String token, Duration timeout) {
        this.name = name;
        this.baseUrl = baseUrl.endsWith("/") ? baseUrl.substring(0, baseUrl.length() - 1) : baseUrl;
        this.token = token == null || token.isBlank() ? null : token;
        this.timeout = timeout;
        this.http = HttpClient.newBuilder().connectTimeout(timeout).followRedirects(HttpClient.Redirect.NORMAL).build();
    }

    public String name() {
        return name;
    }

    public synchronized BreakerState state() {
        if (openUntil == null) {
            return BreakerState.CLOSED;
        }
        return Instant.now().isBefore(openUntil) ? BreakerState.OPEN : BreakerState.HALF_OPEN;
    }

    /** Seconds until an open breaker lets a request through again (0 when it is not open). */
    public synchronized long secondsUntilRetry() {
        if (openUntil == null) {
            return 0;
        }
        return Math.max(0, Duration.between(Instant.now(), openUntil).toSeconds());
    }

    /** The report, or empty when it is not available yet. Throws {@link Unavailable} when the source can't answer. */
    public Optional<MatchReportSource.MatchReport> fetchMatchResult(String externalMatchId) {
        if (state() == BreakerState.OPEN) {
            throw new Unavailable(name + " circuit breaker is open", secondsUntilRetry());
        }
        HttpResponse<String> res;
        try {
            HttpRequest.Builder req = HttpRequest.newBuilder(URI.create(baseUrl + "/v1/matches/" + externalMatchId + "/metadata"))
                    .timeout(timeout)
                    .header("Accept", "application/json").GET();
            if (token != null) {
                req.header("Authorization", "Bearer " + token);
            }
            res = http.send(req.build(), HttpResponse.BodyHandlers.ofString());
        } catch (IOException e) {
            throw failure(name + " unavailable: " + e.getMessage());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new Unavailable("Interrupted", OPEN_FOR.toSeconds());
        }

        int status = res.statusCode();
        if (status == 429 || status == 503) {
            long wait = retryAfter(res).orElse(OPEN_FOR.toSeconds());
            open(wait, "HTTP " + status);
            throw new Unavailable(name + " answered HTTP " + status + " (retry in " + wait + " s)", wait);
        }
        if (status >= 500) {
            throw failure(name + " answered HTTP " + status);
        }
        if (status == 404 || status == 400) {
            recordSuccess();
            return Optional.empty(); // not processed yet
        }
        if (status != 200) {
            throw failure(name + " answered HTTP " + status);
        }
        recordSuccess();
        JsonNode info = Json.read(res.body()).path("match_info");
        if (!info.path("winning_team").isNumber()) {
            return Optional.empty();
        }
        return Optional.of(new MatchReportSource.MatchReport(info.path("winning_team").asInt() + 1,
                info.path("duration_s").asInt(), info.path("not_scored").asBoolean(false)));
    }

    /** Retry-After in seconds (the HTTP-date form is not used by either source). */
    static Optional<Long> retryAfter(HttpResponse<?> res) {
        return res.headers().firstValue("Retry-After").flatMap(v -> {
            try {
                return Optional.of(Math.min(MAX_RETRY_AFTER_S, Math.max(1, Long.parseLong(v.trim()))));
            } catch (NumberFormatException e) {
                return Optional.empty();
            }
        });
    }

    private synchronized void recordSuccess() {
        consecutiveFailures = 0;
        openUntil = null;
    }

    private synchronized Unavailable failure(String message) {
        consecutiveFailures++;
        if (consecutiveFailures >= FAILURE_THRESHOLD || state() == BreakerState.HALF_OPEN) {
            openUntil = Instant.now().plus(OPEN_FOR);
            log.warn("{} circuit breaker OPEN after {} failures: {}", name, consecutiveFailures, message);
        }
        return new Unavailable(message, openUntil == null ? OPEN_FOR.toSeconds() : secondsUntilRetry());
    }

    private synchronized void open(long seconds, String why) {
        consecutiveFailures++;
        openUntil = Instant.now().plusSeconds(seconds);
        log.warn("{} circuit breaker OPEN for {} s: {}", name, seconds, why);
    }
}
