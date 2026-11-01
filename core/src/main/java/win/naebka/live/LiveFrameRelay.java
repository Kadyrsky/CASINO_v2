package win.naebka.live;

import com.fasterxml.jackson.databind.JsonNode;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.redis.listener.ChannelTopic;
import org.springframework.data.redis.listener.RedisMessageListenerContainer;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import win.naebka.common.Json;
import win.naebka.config.NaebkaProperties;
import win.naebka.ws.NaebkaWebSocketHandler;
import win.naebka.ws.WsHub;

/**
 * Realtime map: relays the Steam bot's broadcast frames ({@code naebka:live-frames}, deadlock-bot/src/feeds.rs) to
 * viewers on the WebSocket topic {@code watch:{deadlockMatchId}}.
 *
 * <p>Each frame is held for {@code naebka.live-view.delay-seconds} first. The watcher turns the same frames into match
 * events within about 2 s, which suspends the markets; the delay makes sure that happens before a viewer can see the
 * objective fall or the fight that caused it (courtsiding defence, Risk #1).
 */
@Component
public class LiveFrameRelay {
    public static final String FRAMES = "naebka:live-frames";
    private static final Logger log = LoggerFactory.getLogger(LiveFrameRelay.class);

    private final ScheduledExecutorService delay = Executors.newSingleThreadScheduledExecutor(r -> new Thread(r, "live-frames"));
    private final WsHub ws;
    private final NaebkaWebSocketHandler sockets;
    private final LiveViewPolicy policy;
    private final long delayMs;

    public LiveFrameRelay(RedisMessageListenerContainer container, WsHub ws, NaebkaWebSocketHandler sockets,
                          LiveViewPolicy policy, NaebkaProperties props) {
        this.ws = ws;
        this.sockets = sockets;
        this.policy = policy;
        this.delayMs = props.liveView() == null ? 5_000 : Math.max(0, props.liveView().delaySeconds()) * 1000L;
        container.addMessageListener((message, pattern) -> onFrame(message.getBody()), new ChannelTopic(FRAMES));
    }

    void onFrame(byte[] body) {
        JsonNode frame;
        try {
            frame = Json.read(new String(body, StandardCharsets.UTF_8));
        } catch (RuntimeException e) {
            log.debug("ignoring a malformed live frame");
            return;
        }
        String matchId = frame.path("match_id").asText("");
        if (!matchId.matches("[0-9]{1,20}")) {
            return;
        }
        delay.schedule(() -> ws.publishTransient("watch:" + matchId, "LIVE_FRAME", frame), delayMs, TimeUnit.MILLISECONDS);
    }

    /** Keeps the bot following the matches someone is watching here. */
    @Scheduled(fixedDelay = 20_000, initialDelay = 20_000)
    public void refreshWanted() {
        for (String topic : sockets.subscribedTopics("watch:")) {
            policy.markWanted(topic.substring("watch:".length()));
        }
    }

    @PreDestroy
    void stop() {
        delay.shutdownNow();
    }
}
