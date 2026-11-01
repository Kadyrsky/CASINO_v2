package win.naebka.ws;

import java.time.Instant;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import win.naebka.common.Json;

/**
 * WebSocket fan-out hub (System Architecture Design: "Redis pub/sub will back the WebSocket Hub").
 *
 * <p>Every message gets a per-topic sequence number and is kept in a short Redis buffer, so a client that
 * reconnects with {@code lastSeq} receives what it missed. Messages published inside a DB transaction are
 * only sent after commit — a client never sees a balance or bet that was rolled back.
 */
@Component
public class WsHub {
    public static final String CHANNEL = "naebka:ws";
    private static final int BUFFER_SIZE = 200;
    private static final Duration BUFFER_TTL = Duration.ofHours(2);
    private static final Logger log = LoggerFactory.getLogger(WsHub.class);

    private final StringRedisTemplate redis;

    public WsHub(StringRedisTemplate redis) {
        this.redis = redis;
    }

    public static String userTopic(UUID userId) {
        return "user:" + userId;
    }

    public void publishToUser(UUID userId, String type, Object data) {
        publish(userTopic(userId), type, data);
    }

    public void publish(String topic, String type, Object data) {
        if (TransactionSynchronizationManager.isSynchronizationActive()) {
            TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                @Override
                public void afterCommit() {
                    send(topic, type, data);
                }
            });
        } else {
            send(topic, type, data);
        }
    }

    private void send(String topic, String type, Object data) {
        try {
            Long seq = redis.opsForValue().increment("ws:seq:" + topic);
            Map<String, Object> envelope = new LinkedHashMap<>();
            envelope.put("topic", topic);
            envelope.put("seq", seq);
            envelope.put("ts", Instant.now().toString());
            envelope.put("type", type);
            envelope.put("data", data);
            String json = Json.write(envelope);
            String buf = "ws:buf:" + topic;
            redis.opsForList().rightPush(buf, json);
            redis.opsForList().trim(buf, -BUFFER_SIZE, -1);
            redis.expire(buf, BUFFER_TTL);
            redis.convertAndSend(CHANNEL, json);
        } catch (RuntimeException e) {
            // Live view degrades before betting/wallet do (Risk #8): never fail the caller over a push.
            log.warn("WS publish to {} failed: {}", topic, e.getMessage());
        }
    }

    /**
     * For high-rate data that is only useful while fresh (realtime map frames): no replay buffer and no Redis
     * counter. The time in milliseconds serves as the sequence number, so the client's ordering check still works.
     */
    public void publishTransient(String topic, String type, Object data) {
        try {
            Map<String, Object> envelope = new LinkedHashMap<>();
            envelope.put("topic", topic);
            envelope.put("seq", System.currentTimeMillis());
            envelope.put("ts", Instant.now().toString());
            envelope.put("type", type);
            envelope.put("data", data);
            redis.convertAndSend(CHANNEL, Json.write(envelope));
        } catch (RuntimeException e) {
            log.debug("WS transient publish to {} failed: {}", topic, e.getMessage());
        }
    }

    public long currentSeq(String topic) {
        String v = redis.opsForValue().get("ws:seq:" + topic);
        return v == null ? 0 : Long.parseLong(v);
    }

    /** Buffered messages with seq greater than {@code lastSeq}, oldest first. */
    public List<String> replay(String topic, long lastSeq) {
        List<String> all = redis.opsForList().range("ws:buf:" + topic, 0, -1);
        List<String> out = new ArrayList<>();
        if (all == null) {
            return out;
        }
        for (String json : all) {
            if (Json.read(json).path("seq").asLong() > lastSeq) {
                out.add(json);
            }
        }
        return out;
    }
}
