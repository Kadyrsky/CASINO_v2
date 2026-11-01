package win.naebka.live;

import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;
import win.naebka.config.NaebkaProperties;

/**
 * Official match results: the public Deadlock API first, the team's Steam bot ({@code deadlock-bot serve}) when the
 * API refuses ("too many requests"), fails or has its breaker open.
 *
 * <p>The API allows only about 3 fresh-from-Steam result requests per hour per IP, so right after matches end it is
 * often the bot that answers. An empty answer ("not processed yet") from the API is final for this attempt: the bot
 * asks the same Valve server and would only spend its own, smaller budget. When neither source can answer, the
 * exception carries the shorter of the two waits so settlement retries as soon as one of them can.
 */
@Component
public class FallbackReportSource implements MatchReportSource {
    private static final Logger log = LoggerFactory.getLogger(FallbackReportSource.class);

    private final DeadlockReportClient api;
    private final DeadlockReportClient bot;

    @Autowired
    public FallbackReportSource(NaebkaProperties props) {
        this(new DeadlockReportClient("deadlock-api", props.deadlockApi().baseUrl(), null,
                        Duration.ofSeconds(props.deadlockApi().timeoutSeconds())),
                props.deadlockBot() != null && props.deadlockBot().enabled()
                        ? new DeadlockReportClient("deadlock-bot", props.deadlockBot().baseUrl(),
                                props.deadlockBot().token(), Duration.ofSeconds(props.deadlockBot().timeoutSeconds()))
                        : null);
    }

    /** {@code bot} may be null: no fallback. */
    FallbackReportSource(DeadlockReportClient api, DeadlockReportClient bot) {
        this.api = api;
        this.bot = bot;
    }

    @Override
    public Optional<MatchReport> fetchMatchResult(String externalMatchId) {
        DeadlockReportClient.Unavailable apiDown;
        try {
            return api.fetchMatchResult(externalMatchId);
        } catch (DeadlockReportClient.Unavailable e) {
            apiDown = e;
        }
        if (bot == null) {
            throw apiDown;
        }
        try {
            Optional<MatchReport> report = bot.fetchMatchResult(externalMatchId);
            if (report.isPresent()) {
                log.info("Result of match {} came from deadlock-bot ({})", externalMatchId, apiDown.getMessage());
            }
            return report;
        } catch (DeadlockReportClient.Unavailable e) {
            throw new DeadlockReportClient.Unavailable(apiDown.getMessage() + "; " + e.getMessage(),
                    Math.min(apiDown.retryAfterSeconds(), e.retryAfterSeconds()));
        }
    }

    /** For the admin integrity dashboard: breaker state of each source ("OFF" when the bot is not configured). */
    public Map<String, Object> health() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("deadlockApiBreaker", api.state());
        out.put("deadlockBotBreaker", bot == null ? "OFF" : bot.state());
        return out;
    }
}
