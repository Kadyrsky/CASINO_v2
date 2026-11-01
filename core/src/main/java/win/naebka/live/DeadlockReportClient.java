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
import org.springframework.stereotype.Component;
import win.naebka.common.Exceptions.ExternalScraperUnavailableException;
import win.naebka.common.Json;
import win.naebka.config.NaebkaProperties;

/**
 * Fetches the official post-match report from the public Deadlock API (GET /v1/matches/{id}/metadata),
 * behind a circuit breaker (LLD: ExternalScraperUnavailableException). After 3 consecutive failures the
 * breaker opens for 60 s; settlement then waits (matches stay ENDED = pending settlement).
 */
@Component
public class DeadlockReportClient implements MatchReportSource {
    private static final Logger log = LoggerFactory.getLogger(DeadlockReportClient.class);
    private static final int FAILURE_THRESHOLD = 3;
    private static final Duration OPEN_FOR = Duration.ofSeconds(60);

    public enum BreakerState { CLOSED, OPEN, HALF_OPEN }

    private final HttpClient http;
    private final NaebkaProperties props;
    private int consecutiveFailures;
    private Instant openedAt;

    public DeadlockReportClient(NaebkaProperties props) {
        this.props = props;
        this.http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(props.deadlockApi().timeoutSeconds()))
                .followRedirects(HttpClient.Redirect.NORMAL).build();
    }

    public synchronized BreakerState state() {
        if (openedAt == null) {
            return BreakerState.CLOSED;
        }
        return Instant.now().isAfter(openedAt.plus(OPEN_FOR)) ? BreakerState.HALF_OPEN : BreakerState.OPEN;
    }

    @Override
    public Optional<MatchReport> fetchMatchResult(String externalMatchId) {
        if (state() == BreakerState.OPEN) {
            throw new ExternalScraperUnavailableException("Deadlock API circuit breaker is open");
        }
        try {
            HttpRequest req = HttpRequest.newBuilder(URI.create(props.deadlockApi().baseUrl() + "/v1/matches/"
                            + externalMatchId + "/metadata"))
                    .timeout(Duration.ofSeconds(props.deadlockApi().timeoutSeconds()))
                    .header("Accept", "application/json").GET().build();
            HttpResponse<String> res = http.send(req, HttpResponse.BodyHandlers.ofString());
            if (res.statusCode() == 404 || res.statusCode() == 400) {
                recordSuccess();
                return Optional.empty(); // not processed yet
            }
            if (res.statusCode() >= 500 || res.statusCode() == 429) {
                throw new IOException("HTTP " + res.statusCode());
            }
            recordSuccess();
            JsonNode info = Json.read(res.body()).path("match_info");
            if (!info.path("winning_team").isNumber()) {
                return Optional.empty();
            }
            return Optional.of(new MatchReport(info.path("winning_team").asInt() + 1, info.path("duration_s").asInt(),
                    info.path("not_scored").asBoolean(false)));
        } catch (IOException e) {
            recordFailure(e);
            throw new ExternalScraperUnavailableException("Deadlock API unavailable: " + e.getMessage());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new ExternalScraperUnavailableException("Interrupted");
        }
    }

    private synchronized void recordSuccess() {
        consecutiveFailures = 0;
        openedAt = null;
    }

    private synchronized void recordFailure(Exception e) {
        consecutiveFailures++;
        if (consecutiveFailures >= FAILURE_THRESHOLD || state() == BreakerState.HALF_OPEN) {
            openedAt = Instant.now();
            log.warn("Deadlock API circuit breaker OPEN after {} failures: {}", consecutiveFailures, e.getMessage());
        }
    }
}
