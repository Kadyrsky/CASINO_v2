package win.naebka.ws;

import java.io.IOException;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import win.naebka.common.Json;

/** One connected browser: its socket, the authenticated user (if any) and its topic subscriptions. */
public class WsClient {
    private final WebSocketSession session;
    private final Set<String> topics = ConcurrentHashMap.newKeySet();
    private volatile UUID userId;
    private volatile String username;

    public WsClient(WebSocketSession session) {
        this.session = session;
    }

    public String id() {
        return session.getId();
    }

    public UUID userId() {
        return userId;
    }

    public String username() {
        return username;
    }

    public void authenticate(UUID userId, String username) {
        this.userId = userId;
        this.username = username;
    }

    public String remoteIp() {
        Object forwarded = session.getAttributes().get("clientIp");
        if (forwarded != null) {
            return forwarded.toString();
        }
        return session.getRemoteAddress() == null ? "unknown" : session.getRemoteAddress().getAddress().getHostAddress();
    }

    public Set<String> topics() {
        return topics;
    }

    public void sendRaw(String json) {
        if (!session.isOpen()) {
            return;
        }
        try {
            session.sendMessage(new TextMessage(json));
        } catch (IOException | IllegalStateException e) {
            close();
        }
    }

    public void send(Map<String, Object> payload) {
        sendRaw(Json.write(payload));
    }

    public void close() {
        try {
            session.close(CloseStatus.SESSION_NOT_RELIABLE);
        } catch (IOException ignored) {
            // already gone
        }
    }
}
