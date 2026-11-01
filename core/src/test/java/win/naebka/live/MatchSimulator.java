package win.naebka.live;

import com.fasterxml.jackson.databind.JsonNode;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import win.naebka.common.Json;

/**
 * Scripted Match Simulator (Technical Design, Definition of Done): produces the same normalized events and
 * odds updates the watcher and odds engine would, so full match flows can be tested deterministically.
 */
public class MatchSimulator {
    private final MatchService matches;
    private final String externalId;
    private int elapsed;
    private int nw0 = 5_000;
    private int nw1 = 5_000;
    private int alive0 = 16;
    private int alive1 = 16;

    public MatchSimulator(MatchService matches) {
        this.matches = matches;
        this.externalId = String.valueOf(System.nanoTime());
    }

    public String externalId() {
        return externalId;
    }

    private JsonNode state(Integer winner) {
        return Json.MAPPER.valueToTree(new java.util.LinkedHashMap<>(Map.of(
                "elapsed_s", elapsed, "net_worth", List.of(nw0, nw1), "objectives_alive", List.of(alive0, alive1),
                "objectives_mask", List.of(0, 0), "spectators", 0)) {{
            put("winning_team", winner);
        }});
    }

    private String emit(String type, Map<String, Object> extra, Integer winner) {
        String eventId = UUID.randomUUID().toString();
        var data = new java.util.LinkedHashMap<String, Object>(extra);
        data.put("state", state(winner));
        matches.applyEvent(new MatchEvent(eventId, type, externalId, Instant.now(), Json.MAPPER.valueToTree(data)));
        return eventId;
    }

    public UUID discover() {
        emit(MatchEvent.DISCOVERED, Map.of("start_time", Instant.now().getEpochSecond()), null);
        return matches.findByExternalId(externalId).orElseThrow();
    }

    public void price(String basedOn, String side1, String side2) {
        matches.applyOddsUpdate(new OddsUpdate(externalId, basedOn, List.of(
                new OddsUpdate.MarketPrice("match_winner", Map.of("side1", new BigDecimal(side1), "side2", new BigDecimal(side2)), false),
                new OddsUpdate.MarketPrice("duration_over_under", Map.of("over", new BigDecimal("1.90"), "under", new BigDecimal("1.90")), false))));
    }

    public String destroyObjective(int team) {
        elapsed += 300;
        if (team == 0) {
            alive0--;
        } else {
            alive1--;
        }
        return emit(MatchEvent.OBJECTIVE_DESTROYED, Map.of("team", team, "count", 1), null);
    }

    public void snapshot() {
        elapsed += 10;
        nw0 += 500;
        nw1 += 450;
        emit(MatchEvent.SNAPSHOT, Map.of(), null);
    }

    public void end(Integer winningTeam) {
        elapsed = 1500;
        emit(MatchEvent.ENDED, winningTeam == null ? Map.of() : Map.of("winning_team", winningTeam), winningTeam);
    }
}
