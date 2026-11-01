package win.naebka.live;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/** deadlock-api first, the Steam bot when the API says "too many requests" or is down. */
class FallbackReportSourceTest {
    private static final String REPORT = """
            {"match_id": 7, "match_info": {"winning_team": 1, "duration_s": 1500, "not_scored": false}}""";

    /** A tiny HTTP server that answers from a script and counts requests. */
    static final class Stub {
        record Answer(int status, String body, Map<String, String> headers) {}

        final HttpServer server;
        final Deque<Answer> script = new ArrayDeque<>();
        final AtomicInteger requests = new AtomicInteger();
        final AtomicReference<String> lastAuthorization = new AtomicReference<>();
        Answer fallback = new Answer(200, REPORT, Map.of());

        Stub() throws IOException {
            server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            server.createContext("/", exchange -> {
                requests.incrementAndGet();
                lastAuthorization.set(exchange.getRequestHeaders().getFirst("Authorization"));
                Answer a;
                synchronized (script) {
                    a = script.isEmpty() ? fallback : script.poll();
                }
                a.headers().forEach((k, v) -> exchange.getResponseHeaders().add(k, v));
                byte[] bytes = a.body().getBytes(StandardCharsets.UTF_8);
                exchange.sendResponseHeaders(a.status(), bytes.length == 0 ? -1 : bytes.length);
                if (bytes.length > 0) {
                    exchange.getResponseBody().write(bytes);
                }
                exchange.close();
            });
            server.start();
        }

        String url() {
            return "http://127.0.0.1:" + server.getAddress().getPort();
        }

        Stub then(int status, String body, Map<String, String> headers) {
            synchronized (script) {
                script.add(new Answer(status, body, headers));
            }
            return this;
        }
    }

    Stub api;
    Stub bot;

    @BeforeEach
    void start() throws IOException {
        api = new Stub();
        bot = new Stub();
    }

    @AfterEach
    void stop() {
        api.server.stop(0);
        bot.server.stop(0);
    }

    FallbackReportSource source(boolean withBot) {
        var apiClient = new DeadlockReportClient("deadlock-api", api.url(), null, Duration.ofSeconds(5));
        var botClient = withBot ? new DeadlockReportClient("deadlock-bot", bot.url(), "secret", Duration.ofSeconds(5)) : null;
        return new FallbackReportSource(apiClient, botClient);
    }

    @Test
    void usesTheApiWhenItAnswers() {
        var report = source(true).fetchMatchResult("7");
        assertThat(report).contains(new MatchReportSource.MatchReport(2, 1500, false));
        assertThat(bot.requests).hasValue(0);
    }

    @Test
    void asksTheBotWhenTheApiSaysTooManyRequests() {
        api.then(429, "", Map.of("Retry-After", "120"));
        var reports = source(true);

        assertThat(reports.fetchMatchResult("7")).contains(new MatchReportSource.MatchReport(2, 1500, false));
        assertThat(bot.lastAuthorization).hasValue("Bearer secret");
        assertThat(reports.health()).containsEntry("deadlockApiBreaker", DeadlockReportClient.BreakerState.OPEN);

        // The API's breaker stays open for its Retry-After: the next result goes straight to the bot.
        assertThat(reports.fetchMatchResult("8")).isPresent();
        assertThat(api.requests).hasValue(1);
        assertThat(bot.requests).hasValue(2);
    }

    @Test
    void notProcessedYetIsFinalAndDoesNotSpendTheBotsBudget() {
        api.then(404, "{}", Map.of());
        assertThat(source(true).fetchMatchResult("7")).isEmpty();
        assertThat(bot.requests).hasValue(0);
    }

    @Test
    void readsTheBotsResultShapeIncludingNotScored() {
        api.then(503, "", Map.of());
        bot.then(200, """
                {"match_id": 9, "match_info": {"winning_team": 0, "duration_s": 2100, "not_scored": true}}""", Map.of());
        assertThat(source(true).fetchMatchResult("9")).contains(new MatchReportSource.MatchReport(1, 2100, true));
    }

    @Test
    void bothDownWaitsForTheSoonerOne() {
        api.then(429, "", Map.of("Retry-After", "300"));
        bot.then(429, "", Map.of("Retry-After", "45"));
        assertThatThrownBy(() -> source(true).fetchMatchResult("7"))
                .isInstanceOfSatisfying(DeadlockReportClient.Unavailable.class,
                        e -> assertThat(e.retryAfterSeconds()).isEqualTo(45));
    }

    @Test
    void withoutABotTheApiErrorIsPassedOn() {
        api.then(429, "", Map.of("Retry-After", "30"));
        var reports = source(false);
        assertThatThrownBy(() -> reports.fetchMatchResult("7"))
                .isInstanceOfSatisfying(DeadlockReportClient.Unavailable.class,
                        e -> assertThat(e.retryAfterSeconds()).isEqualTo(30));
        assertThat(reports.health()).containsEntry("deadlockBotBreaker", "OFF");
    }

    @Test
    void threeServerErrorsOpenTheBreaker() {
        api.fallback = new Stub.Answer(500, "", Map.of());
        var reports = source(false);
        for (int i = 0; i < 3; i++) {
            assertThatThrownBy(() -> reports.fetchMatchResult("7")).isInstanceOf(DeadlockReportClient.Unavailable.class);
        }
        assertThat(reports.health()).containsEntry("deadlockApiBreaker", DeadlockReportClient.BreakerState.OPEN);
        assertThatThrownBy(() -> reports.fetchMatchResult("7")).isInstanceOf(DeadlockReportClient.Unavailable.class);
        assertThat(api.requests).hasValue(3);
    }

    @Test
    void anUnreachableBotCountsAsUnavailable() {
        api.then(429, "", Map.of());
        bot.server.stop(0);
        assertThatThrownBy(() -> source(true).fetchMatchResult("7"))
                .isInstanceOf(DeadlockReportClient.Unavailable.class)
                .hasMessageContaining("deadlock-bot");
    }
}
