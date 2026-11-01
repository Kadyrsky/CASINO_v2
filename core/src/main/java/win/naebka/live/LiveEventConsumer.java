package win.naebka.live;

import com.fasterxml.jackson.databind.JsonNode;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.redis.listener.ChannelTopic;
import org.springframework.data.redis.listener.RedisMessageListenerContainer;
import org.springframework.stereotype.Component;
import jakarta.annotation.PreDestroy;
import win.naebka.common.Json;

/**
 * Subscribes to the message broker (System Architecture Design: "Watcher to Core/Odds via Redis Pub/Sub").
 * Messages are handed to a single thread so events of a match are applied strictly in order.
 */
@Component
public class LiveEventConsumer {
    public static final String MATCH_EVENTS = "naebka:match-events";
    public static final String ODDS_UPDATES = "naebka:odds-updates";
    private static final Logger log = LoggerFactory.getLogger(LiveEventConsumer.class);

    private final ExecutorService worker = Executors.newSingleThreadExecutor(r -> new Thread(r, "live-events"));
    private final MatchService matches;

    public LiveEventConsumer(RedisMessageListenerContainer container, MatchService matches) {
        this.matches = matches;
        container.addMessageListener((message, pattern) -> enqueue(message.getBody(), false),
                new ChannelTopic(MATCH_EVENTS));
        container.addMessageListener((message, pattern) -> enqueue(message.getBody(), true),
                new ChannelTopic(ODDS_UPDATES));
    }

    private void enqueue(byte[] body, boolean odds) {
        String json = new String(body, StandardCharsets.UTF_8);
        worker.submit(() -> {
            try {
                JsonNode node = Json.read(json);
                if (odds) {
                    matches.applyOddsUpdate(OddsUpdate.from(node));
                } else {
                    matches.applyEvent(MatchEvent.from(node));
                }
            } catch (RuntimeException e) {
                log.error("Failed to apply {} message: {}", odds ? "odds" : "match", json, e);
            }
        });
    }

    @PreDestroy
    void stop() {
        worker.shutdown();
    }
}
