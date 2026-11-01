package win.naebka.live;

import com.fasterxml.jackson.databind.JsonNode;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import win.naebka.common.Json;
import win.naebka.config.NaebkaProperties;
import win.naebka.ws.WsHub;

/**
 * Applies the watcher's event stream and the odds engine's prices to matches and markets.
 *
 * <p>Market state machine (Technical Design: suspend-then-reprice):
 * <pre>
 *   SUSPENDED(awaiting price) → OPEN ⇄ SUSPENDED → CLOSED → SETTLED
 *                               any non-final state → VOID
 * </pre>
 * A state-changing event suspends every open market of the match <em>before</em> any new price exists;
 * the market only reopens when the odds engine has priced the new state. Every price written to
 * {@code selections} is also appended to {@code odds_history}.
 */
@Service
public class MatchService {
    private static final Logger log = LoggerFactory.getLogger(MatchService.class);

    private final JdbcClient jdbc;
    private final WsHub ws;
    private final NaebkaProperties props;
    private final PlayerDirectory playerDirectory;

    public MatchService(JdbcClient jdbc, WsHub ws, NaebkaProperties props, PlayerDirectory playerDirectory) {
        this.jdbc = jdbc;
        this.ws = ws;
        this.props = props;
        this.playerDirectory = playerDirectory;
    }

    public static String topic(UUID matchId) {
        return "match:" + matchId;
    }

    // ------------------------------------------------------------------ events

    @Transactional
    public void applyEvent(MatchEvent event) {
        if (MatchEvent.HEARTBEAT.equals(event.type()) || event.externalMatchId() == null) {
            return;
        }
        Optional<UUID> existing = findByExternalId(event.externalMatchId());
        if (MatchEvent.DISCOVERED.equals(event.type()) && existing.isPresent()) {
            // The watcher re-announces tracked matches periodically; only fill in a roster that is still missing.
            JsonNode players = event.data().path("players");
            if (players.isArray() && !players.isEmpty()) {
                jdbc.sql("UPDATE matches SET players = ?::jsonb, meta = ?::jsonb WHERE id = ? AND players = '[]'::jsonb")
                        .params(Json.write(players), Json.write(meta(event.data())), existing.get()).update();
            }
            return;
        }
        UUID matchId = MatchEvent.DISCOVERED.equals(event.type()) ? createIfAbsent(event) : existing.orElse(null);
        if (matchId == null) {
            return; // not announced yet (e.g. core restarted mid-match); the next announcement creates it
        }
        String status = jdbc.sql("SELECT status FROM matches WHERE id = ? FOR UPDATE").param(matchId)
                .query(String.class).single();
        if (!List.of("LIVE", "STALE").contains(status)) {
            return; // ended/settled matches ignore late events
        }

        int inserted = jdbc.sql("""
                INSERT INTO match_events (match_id, event_id, type, payload, occurred_at)
                VALUES (?, ?, ?, ?::jsonb, ?) ON CONFLICT (event_id) DO NOTHING""")
                .params(matchId, event.eventId(), event.type(), Json.write(event.data()),
                        java.sql.Timestamp.from(event.ts()))
                .update();
        if (inserted == 0) {
            return; // duplicate delivery
        }

        JsonNode state = event.state();
        if (!state.isMissingNode() && !state.isEmpty()) {
            jdbc.sql("UPDATE matches SET state = ?::jsonb, last_event_at = now() WHERE id = ?")
                    .params(Json.write(state), matchId).update();
        } else {
            jdbc.sql("UPDATE matches SET last_event_at = now() WHERE id = ?").param(matchId).update();
        }

        if (event.isStateChanging()) {
            suspendMarkets(matchId, event.type());
        }

        switch (event.type()) {
            case MatchEvent.STALE -> jdbc.sql("UPDATE matches SET status = 'STALE' WHERE id = ?").param(matchId).update();
            case MatchEvent.ENDED -> endMatch(matchId, event);
            default -> {
                if ("STALE".equals(status)) {
                    // Data is flowing again; markets stay suspended until the next price arrives.
                    jdbc.sql("UPDATE matches SET status = 'LIVE' WHERE id = ?").param(matchId).update();
                }
            }
        }

        Map<String, Object> payload = Map.of("matchId", matchId, "eventType", event.type(), "data", event.data(),
                "ts", event.ts().toString());
        ws.publish(topic(matchId), "MATCH_EVENT", payload);
        if (!MatchEvent.SNAPSHOT.equals(event.type()) || state.size() > 0) {
            ws.publish("lobby", "MATCH_STATE", Map.of("matchId", matchId, "state", state, "eventType", event.type()));
        }
    }

    private UUID createIfAbsent(MatchEvent event) {
        Optional<UUID> existing = findByExternalId(event.externalMatchId());
        if (existing.isPresent()) {
            return existing.get();
        }
        JsonNode d = event.data();
        Instant startsAt = d.has("start_time") ? Instant.ofEpochSecond(d.path("start_time").asLong()) : event.ts();
        JsonNode players = d.path("players").isArray() ? d.path("players") : Json.read("[]");
        UUID matchId = jdbc.sql("""
                INSERT INTO matches (game_id, external_id, status, starts_at, state, players, meta)
                SELECT id, ?, 'LIVE', ?, ?::jsonb, ?::jsonb, ?::jsonb FROM games WHERE code = 'deadlock'
                RETURNING id""")
                .params(event.externalMatchId(), java.sql.Timestamp.from(startsAt), Json.write(d.path("state")),
                        Json.write(players), Json.write(meta(d)))
                .query(UUID.class).single();
        jdbc.sql("""
                INSERT INTO match_participants (match_id, team_id, side)
                SELECT ?, t.id, CASE t.external_id WHEN '0' THEN 1 ELSE 2 END
                FROM teams t JOIN games g ON g.id = t.game_id WHERE g.code = 'deadlock'""")
                .param(matchId).update();

        UUID winner = insertMarket(matchId, "match_winner", "Match winner", null);
        insertSelection(winner, "side1", "Hidden King");
        insertSelection(winner, "side2", "Archmother");
        UUID duration = insertMarket(matchId, "duration_over_under", "Match duration over/under 30:00",
                new BigDecimal("30.0"));
        insertSelection(duration, "over", "Over 30:00");
        insertSelection(duration, "under", "Under 30:00");

        jdbc.sql("INSERT INTO chat_rooms (match_id, name) VALUES (?, ?)")
                .params(matchId, "Match " + event.externalMatchId()).update();
        ws.publish("lobby", "MATCH_ADDED", Map.of("matchId", matchId, "externalId", event.externalMatchId()));
        log.info("Discovered Deadlock match {} -> {}", event.externalMatchId(), matchId);
        return matchId;
    }

    /** What the match page shows about a match besides its state: region, mode and Valve's rank score. */
    private static Map<String, Object> meta(JsonNode d) {
        Map<String, Object> m = new java.util.LinkedHashMap<>();
        for (String key : List.of("region", "match_mode", "game_mode", "match_score")) {
            JsonNode v = d.path(key);
            if (v.isTextual() && !v.asText().isEmpty()) {
                m.put(key, v.asText());
            } else if (v.isNumber()) {
                m.put(key, v.asLong());
            }
        }
        return m;
    }

    private UUID insertMarket(UUID matchId, String type, String name, BigDecimal line) {
        return jdbc.sql("""
                INSERT INTO markets (match_id, market_type, name, status, line, suspended_at, suspend_reason)
                VALUES (?, ?, ?, 'SUSPENDED', ?, now(), 'AWAITING_PRICE') RETURNING id""")
                .params(matchId, type, name, line).query(UUID.class).single();
    }

    private void insertSelection(UUID marketId, String key, String name) {
        jdbc.sql("INSERT INTO selections (market_id, outcome_key, name) VALUES (?, ?, ?)")
                .params(marketId, key, name).update();
    }

    private void endMatch(UUID matchId, MatchEvent event) {
        JsonNode winning = event.data().path("winning_team");
        Integer side = winning.isNumber() ? winning.asInt() + 1 : null;
        jdbc.sql("""
                UPDATE matches SET status = 'ENDED', ended_at = now(), stream_winner_side = ?,
                       next_settle_at = now() + interval '30 seconds'
                WHERE id = ?""")
                .params(side, matchId).update();
        jdbc.sql("""
                UPDATE markets SET status = 'CLOSED', suspended_at = coalesce(suspended_at, now())
                WHERE match_id = ? AND status IN ('OPEN', 'SUSPENDED')""")
                .param(matchId).update();
        ws.publish(topic(matchId), "MATCH_ENDED", Map.of("matchId", matchId));
        ws.publish("lobby", "MATCH_ENDED", Map.of("matchId", matchId));
    }

    /** OPEN → SUSPENDED for every open market of the match; returns how many were suspended. */
    @Transactional
    public int suspendMarkets(UUID matchId, String reason) {
        int n = jdbc.sql("""
                UPDATE markets SET status = 'SUSPENDED', suspended_at = now(), suspend_reason = ?,
                       price_version = price_version + 1
                WHERE match_id = ? AND status = 'OPEN'""")
                .params(reason, matchId).update();
        if (n > 0) {
            ws.publish(topic(matchId), "MARKETS_SUSPENDED", Map.of("matchId", matchId, "reason", reason));
            ws.publish("lobby", "MARKETS_SUSPENDED", Map.of("matchId", matchId, "reason", reason));
        }
        return n;
    }

    // ------------------------------------------------------------------ prices

    @Transactional
    public void applyOddsUpdate(OddsUpdate update) {
        Optional<UUID> found = findByExternalId(update.externalMatchId());
        if (found.isEmpty()) {
            return;
        }
        UUID matchId = found.get();
        String status = jdbc.sql("SELECT status FROM matches WHERE id = ? FOR UPDATE").param(matchId)
                .query(String.class).single();
        if (!"LIVE".equals(status)) {
            return; // stale/ended matches never reopen on a price
        }
        String reason = update.basedOnEventId() == null ? "reprice" : "event:" + update.basedOnEventId();
        boolean changed = false;
        for (OddsUpdate.MarketPrice price : update.markets()) {
            changed |= applyMarketPrice(matchId, price, reason);
        }
        if (changed) {
            ws.publish(topic(matchId), "ODDS_UPDATED", Map.of("matchId", matchId, "markets", marketsOf(matchId)));
            ws.publish("lobby", "ODDS_UPDATED", Map.of("matchId", matchId, "markets", marketsOf(matchId)));
        }
    }

    private boolean applyMarketPrice(UUID matchId, OddsUpdate.MarketPrice price, String reason) {
        record MarketRow(UUID id, String status) {}
        Optional<MarketRow> market = jdbc.sql("""
                SELECT id, status FROM markets WHERE match_id = ? AND market_type = ? FOR UPDATE""")
                .params(matchId, price.marketType())
                .query((rs, i) -> new MarketRow(rs.getObject(1, UUID.class), rs.getString(2))).optional();
        if (market.isEmpty() || !List.of("OPEN", "SUSPENDED").contains(market.get().status())) {
            return false;
        }
        UUID marketId = market.get().id();
        if (price.close()) {
            jdbc.sql("UPDATE markets SET status = 'CLOSED', suspend_reason = 'OUTCOME_DECIDED' WHERE id = ?")
                    .param(marketId).update();
            return true;
        }
        // Plausibility watchdog (Risk #11): absurd prices keep the market suspended.
        for (BigDecimal odds : price.odds().values()) {
            if (odds.compareTo(props.betting().minOdds()) < 0 || odds.compareTo(props.betting().maxOdds()) > 0) {
                jdbc.sql("""
                        UPDATE markets SET status = 'SUSPENDED', suspended_at = now(), suspend_reason = 'PLAUSIBILITY',
                               price_version = price_version + 1 WHERE id = ? AND status = 'OPEN'""")
                        .param(marketId).update();
                log.warn("Odds {} for market {} outside plausibility band; kept suspended", price.odds(), marketId);
                return true;
            }
        }
        boolean priceChanged = false;
        for (var e : price.odds().entrySet()) {
            BigDecimal odds = e.getValue().setScale(2, java.math.RoundingMode.HALF_UP);
            Optional<UUID> selection = jdbc.sql("""
                    UPDATE selections SET odds = ? WHERE market_id = ? AND outcome_key = ?
                      AND odds IS DISTINCT FROM ? RETURNING id""")
                    .params(odds, marketId, e.getKey(), odds).query(UUID.class).optional();
            if (selection.isPresent()) {
                priceChanged = true;
                jdbc.sql("INSERT INTO odds_history (selection_id, odds, reason) VALUES (?, ?, ?)")
                        .params(selection.get(), odds, reason).update();
            }
        }
        if ("SUSPENDED".equals(market.get().status())) {
            // Re-opening at the new price: SUSPENDED → OPEN.
            jdbc.sql("""
                    UPDATE markets SET status = 'OPEN', suspended_at = NULL, suspend_reason = NULL,
                           price_version = price_version + 1 WHERE id = ?""")
                    .param(marketId).update();
            return true;
        }
        if (priceChanged) {
            // Never reprice an open market in place: the version bump makes any in-flight bet fail
            // with PRICE_CHANGED, exactly as if the market had been suspended in between.
            jdbc.sql("UPDATE markets SET price_version = price_version + 1 WHERE id = ?").param(marketId).update();
        }
        return priceChanged;
    }

    // ------------------------------------------------------------------ watchdog

    /** Marks matches without recent watcher data STALE and suspends their markets (Risk #14). */
    @Transactional
    public int markStale(int afterSeconds) {
        List<UUID> stale = jdbc.sql("""
                UPDATE matches SET status = 'STALE'
                WHERE status = 'LIVE' AND last_event_at < now() - make_interval(secs => ?)
                RETURNING id""")
                .param(afterSeconds).query(UUID.class).list();
        stale.forEach(id -> suspendMarkets(id, "STALE"));
        return stale.size();
    }

    /** Matches stale for a long time are treated as ended; settlement then relies on the official report. */
    @Transactional
    public int endAbandoned(int afterMinutes) {
        List<UUID> ended = jdbc.sql("""
                UPDATE matches SET status = 'ENDED', ended_at = now(), next_settle_at = now(),
                       review_reason = 'STREAM_LOST'
                WHERE status = 'STALE' AND last_event_at < now() - make_interval(mins => ?)
                RETURNING id""")
                .param(afterMinutes).query(UUID.class).list();
        for (UUID id : ended) {
            jdbc.sql("UPDATE markets SET status = 'CLOSED' WHERE match_id = ? AND status IN ('OPEN', 'SUSPENDED')")
                    .param(id).update();
            ws.publish("lobby", "MATCH_ENDED", Map.of("matchId", id));
        }
        return ended.size();
    }

    // ------------------------------------------------------------------ queries

    public Optional<UUID> findByExternalId(String externalId) {
        return jdbc.sql("""
                SELECT m.id FROM matches m JOIN games g ON g.id = m.game_id
                WHERE g.code = 'deadlock' AND m.external_id = ?""")
                .param(externalId).query(UUID.class).optional();
    }

    public record SelectionView(UUID id, String outcomeKey, String name, BigDecimal odds, String result) {}

    public record MarketView(UUID id, String marketType, String name, String status, BigDecimal line,
                             String suspendReason, long priceVersion, List<SelectionView> selections) {}

    /**
     * {@code players}: [{account_id, team (0/1), hero_id, name, avatar, badge}], names and badges where the watcher has
     * them; {@code meta}: region, match_mode, game_mode, match_score.
     */
    public record MatchView(UUID id, String externalId, String game, String status, Instant startsAt,
                            Instant endedAt, JsonNode state, List<Map<String, Object>> teams,
                            List<MarketView> markets, UUID chatRoomId, String reviewReason,
                            List<Map<String, Object>> players, JsonNode meta) {}

    public List<MarketView> marketsOf(UUID matchId) {
        List<MarketView> markets = jdbc.sql("""
                SELECT id, market_type, name, status, line, suspend_reason, price_version FROM markets
                WHERE match_id = ? ORDER BY market_type DESC""")
                .param(matchId)
                .query((rs, i) -> new MarketView(rs.getObject(1, UUID.class), rs.getString(2), rs.getString(3),
                        rs.getString(4), rs.getBigDecimal(5), rs.getString(6), rs.getLong(7), List.of()))
                .list();
        return markets.stream().map(m -> new MarketView(m.id(), m.marketType(), m.name(), m.status(), m.line(),
                m.suspendReason(), m.priceVersion(), jdbc.sql("""
                        SELECT id, outcome_key, name, odds, result FROM selections WHERE market_id = ?
                        ORDER BY outcome_key""")
                .param(m.id())
                .query((rs, i) -> new SelectionView(rs.getObject(1, UUID.class), rs.getString(2), rs.getString(3),
                        rs.getBigDecimal(4), rs.getString(5)))
                .list())).toList();
    }

    public Optional<MatchView> view(UUID matchId) {
        return jdbc.sql("""
                SELECT m.id, m.external_id, g.code, m.status, m.starts_at, m.ended_at, m.state::text,
                       (SELECT id FROM chat_rooms WHERE match_id = m.id) AS room, m.review_reason,
                       m.players::text, m.meta::text
                FROM matches m JOIN games g ON g.id = m.game_id WHERE m.id = ?""")
                .param(matchId)
                .query((rs, i) -> new MatchView(rs.getObject(1, UUID.class), rs.getString(2), rs.getString(3),
                        rs.getString(4), rs.getTimestamp(5).toInstant(),
                        rs.getTimestamp(6) == null ? null : rs.getTimestamp(6).toInstant(), Json.read(rs.getString(7)),
                        teams(matchId), marketsOf(matchId), rs.getObject(8, UUID.class), rs.getString(9),
                        playerDirectory.enrich(Json.read(rs.getString(10))), Json.read(rs.getString(11))))
                .optional();
    }

    private List<Map<String, Object>> teams(UUID matchId) {
        return jdbc.sql("""
                SELECT t.name, p.side, p.is_winner FROM match_participants p JOIN teams t ON t.id = p.team_id
                WHERE p.match_id = ? ORDER BY p.side""")
                .param(matchId)
                .query((rs, i) -> {
                    Map<String, Object> m = new java.util.LinkedHashMap<>();
                    m.put("name", rs.getString(1));
                    m.put("side", rs.getInt(2));
                    m.put("isWinner", rs.getObject(3));
                    return m;
                })
                .list();
    }

    public List<MatchView> list(String filter) {
        String where = switch (filter == null ? "live" : filter) {
            case "recent" -> "m.status IN ('ENDED', 'REVIEW', 'SETTLED', 'VOID') AND m.created_at > now() - interval '1 day'";
            case "all" -> "true";
            default -> "m.status IN ('LIVE', 'STALE')";
        };
        List<UUID> ids = jdbc.sql("SELECT m.id FROM matches m WHERE " + where + " ORDER BY m.starts_at DESC LIMIT 50")
                .query(UUID.class).list();
        return ids.stream().map(this::view).flatMap(Optional::stream).toList();
    }

    public record EventView(long id, String type, JsonNode data, Instant occurredAt) {}

    public List<EventView> recentEvents(UUID matchId, int limit) {
        return jdbc.sql("""
                SELECT id, type, payload::text, occurred_at FROM match_events
                WHERE match_id = ? AND type <> 'match.snapshot' ORDER BY id DESC LIMIT ?""")
                .params(matchId, limit)
                .query((rs, i) -> new EventView(rs.getLong(1), rs.getString(2), Json.read(rs.getString(3)),
                        rs.getTimestamp(4).toInstant()))
                .list();
    }

    public record OddsPoint(UUID selectionId, BigDecimal odds, Instant recordedAt) {}

    public List<OddsPoint> oddsHistory(UUID matchId) {
        return jdbc.sql("""
                SELECT h.selection_id, h.odds, h.recorded_at FROM odds_history h
                JOIN selections s ON s.id = h.selection_id JOIN markets mk ON mk.id = s.market_id
                WHERE mk.match_id = ? ORDER BY h.recorded_at""")
                .param(matchId)
                .query((rs, i) -> new OddsPoint(rs.getObject(1, UUID.class), rs.getBigDecimal(2),
                        rs.getTimestamp(3).toInstant()))
                .list();
    }
}
