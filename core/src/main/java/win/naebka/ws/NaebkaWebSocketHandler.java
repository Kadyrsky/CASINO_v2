package win.naebka.ws;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtException;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.ConcurrentWebSocketSessionDecorator;
import org.springframework.web.socket.handler.TextWebSocketHandler;
import win.naebka.auth.AuthUser;
import win.naebka.common.ErrorCode;
import win.naebka.common.Exceptions.NaebkaException;
import win.naebka.common.Json;

/**
 * Single WebSocket endpoint. Protocol (JSON text frames):
 * <ul>
 *   <li>{@code {op:"auth", token}} — authenticate; the JWT is never put in the URL.</li>
 *   <li>{@code {op:"subscribe", topic, lastSeq?}} — topics: lobby, match:{id}, poker:{id}, chat:{id}, user:{ownId}.</li>
 *   <li>{@code {op:"unsubscribe", topic}}, {@code {op:"ping"}}</li>
 *   <li>Anything else is routed to a {@link WsCommandHandler} by op prefix (e.g. {@code poker.action}).</li>
 * </ul>
 * Paths /ws/lobby and /ws/matches/{id} (Technical Design interface spec) auto-subscribe to their topic.
 */
@Component
public class NaebkaWebSocketHandler extends TextWebSocketHandler {
    private static final Logger log = LoggerFactory.getLogger(NaebkaWebSocketHandler.class);
    private static final Pattern PUBLIC_TOPIC = Pattern.compile("lobby|(match|poker|chat):[0-9a-f-]{36}");

    private final Map<String, WsClient> clients = new ConcurrentHashMap<>();
    private final Map<UUID, Integer> connectionsPerUser = new ConcurrentHashMap<>();
    private final JwtDecoder jwtDecoder;
    private final WsHub hub;
    private final List<WsCommandHandler> commandHandlers;

    public NaebkaWebSocketHandler(JwtDecoder jwtDecoder, WsHub hub, List<WsCommandHandler> commandHandlers) {
        this.jwtDecoder = jwtDecoder;
        this.hub = hub;
        this.commandHandlers = commandHandlers;
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession raw) {
        // Slow consumers are cut off rather than allowed to back up the hub (Risk #8: degrade live view first).
        var session = new ConcurrentWebSocketSessionDecorator(raw, 5_000, 512 * 1024);
        WsClient client = new WsClient(session);
        clients.put(raw.getId(), client);
        String path = raw.getUri() == null ? "" : raw.getUri().getPath();
        if (path.endsWith("/ws/lobby")) {
            subscribe(client, "lobby", -1);
        } else if (path.matches(".*/ws/matches/[0-9a-f-]{36}")) {
            subscribe(client, "match:" + path.substring(path.lastIndexOf('/') + 1), -1);
        }
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        WsClient client = clients.remove(session.getId());
        if (client != null && client.userId() != null) {
            UUID userId = client.userId();
            Integer left = connectionsPerUser.computeIfPresent(userId, (k, n) -> n <= 1 ? null : n - 1);
            if (left == null) {
                commandHandlers.forEach(h -> h.onUserDisconnected(userId));
            }
        }
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) {
        WsClient client = clients.get(session.getId());
        if (client == null) {
            return;
        }
        JsonNode msg;
        try {
            msg = Json.read(message.getPayload());
        } catch (IllegalArgumentException e) {
            sendError(client, ErrorCode.VALIDATION_FAILED, "Malformed JSON");
            return;
        }
        String op = msg.path("op").asText("");
        try {
            switch (op) {
                case "ping" -> client.send(Map.of("type", "PONG"));
                case "auth" -> authenticate(client, msg.path("token").asText(""));
                case "subscribe" -> subscribe(client, msg.path("topic").asText(""), msg.path("lastSeq").asLong(-1));
                case "unsubscribe" -> client.topics().remove(msg.path("topic").asText(""));
                default -> dispatch(client, op, msg);
            }
        } catch (NaebkaException e) {
            sendError(client, e.code(), e.getMessage());
        } catch (RuntimeException e) {
            log.error("WS command {} failed", op, e);
            sendError(client, ErrorCode.INTERNAL_ERROR, "Internal error");
        }
    }

    private void authenticate(WsClient client, String token) {
        try {
            AuthUser user = AuthUser.fromJwt(jwtDecoder.decode(token));
            boolean first = client.userId() == null;
            client.authenticate(user.id(), user.username());
            if (first) {
                connectionsPerUser.merge(user.id(), 1, Integer::sum);
            }
            client.send(Map.of("type", "AUTH_OK", "userId", user.id().toString()));
            subscribe(client, WsHub.userTopic(user.id()), -1);
            commandHandlers.forEach(h -> h.onUserConnected(user.id()));
        } catch (JwtException | IllegalArgumentException e) {
            sendError(client, ErrorCode.UNAUTHORIZED, "Invalid or expired token");
        }
    }

    private void subscribe(WsClient client, String topic, long lastSeq) {
        boolean ownUserTopic = client.userId() != null && topic.equals(WsHub.userTopic(client.userId()));
        if (!ownUserTopic && !PUBLIC_TOPIC.matcher(topic).matches()) {
            sendError(client, ErrorCode.FORBIDDEN, "Cannot subscribe to " + topic);
            return;
        }
        client.topics().add(topic);
        if (lastSeq >= 0) {
            hub.replay(topic, lastSeq).forEach(client::sendRaw);
        }
        client.send(Map.of("type", "SUBSCRIBED", "topic", topic, "seq", hub.currentSeq(topic)));
    }

    private void dispatch(WsClient client, String op, JsonNode msg) {
        for (WsCommandHandler h : commandHandlers) {
            if (op.startsWith(h.prefix())) {
                if (client.userId() == null) {
                    sendError(client, ErrorCode.UNAUTHORIZED, "Send {op:'auth'} first");
                    return;
                }
                h.handle(client, op, msg);
                return;
            }
        }
        sendError(client, ErrorCode.VALIDATION_FAILED, "Unknown op " + op);
    }

    /** LLD error frame: { "event": "ERROR", "code": 1001, "message": "..." }. */
    public static void sendError(WsClient client, ErrorCode code, String message) {
        client.send(Map.of("type", "ERROR", "event", "ERROR", "code", code.wsCode(), "error", code.name(),
                "message", message));
    }

    /** Called by the Redis listener for every hub message: deliver to local subscribers of its topic. */
    public void deliver(String topic, String json) {
        for (WsClient c : clients.values()) {
            if (c.topics().contains(topic)) {
                c.sendRaw(json);
            }
        }
    }

    /** Direct, unbuffered message to one user's sockets on this instance (e.g. a poker sync after an error). */
    public void sendToUser(UUID userId, Map<String, Object> payload) {
        for (WsClient c : clients.values()) {
            if (userId.equals(c.userId())) {
                c.send(payload);
            }
        }
    }

    public boolean isOnline(UUID userId) {
        return connectionsPerUser.containsKey(userId);
    }
}
