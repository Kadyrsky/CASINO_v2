package win.naebka.live;

import com.fasterxml.jackson.databind.JsonNode;
import java.time.Instant;
import java.util.Set;

/**
 * One normalized event from the Watcher (game-agnostic taxonomy, Technical Design: Watcher Fleet).
 * {@code externalMatchId} is the Deadlock match id; {@code data.state} carries the normalized match state.
 */
public record MatchEvent(String eventId, String type, String externalMatchId, Instant ts, JsonNode data) {
    public static final String DISCOVERED = "match.discovered";
    public static final String SNAPSHOT = "match.snapshot";
    public static final String OBJECTIVE_DESTROYED = "objective.destroyed";
    public static final String NETWORTH_SWING = "networth.swing";
    public static final String STALE = "match.stale";
    public static final String ENDED = "match.ended";
    public static final String HEARTBEAT = "watcher.heartbeat";

    /** Events after which current prices can no longer be trusted: suspend first, reprice after. */
    public static final Set<String> STATE_CHANGING = Set.of(OBJECTIVE_DESTROYED, NETWORTH_SWING, STALE, ENDED);

    public static MatchEvent from(JsonNode node) {
        return new MatchEvent(node.path("event_id").asText(), node.path("type").asText(),
                node.path("match_id").asText(null), Instant.parse(node.path("ts").asText()), node.path("data"));
    }

    public boolean isStateChanging() {
        return STATE_CHANGING.contains(type);
    }

    public JsonNode state() {
        return data.path("state");
    }
}
