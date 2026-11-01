package win.naebka.ws;

import com.fasterxml.jackson.databind.JsonNode;

/** Handles client → server WebSocket commands whose {@code op} starts with {@link #prefix()} (e.g. "poker."). */
public interface WsCommandHandler {
    String prefix();

    void handle(WsClient client, String op, JsonNode message);

    /** Called when an authenticated user connects (e.g. poker reconnect within the grace period). */
    default void onUserConnected(java.util.UUID userId) {}

    /** Called when the user's last socket closes (e.g. poker disconnect timer). */
    default void onUserDisconnected(java.util.UUID userId) {}
}
