package win.naebka.live;

import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.transaction.annotation.Transactional;
import win.naebka.auth.AuthUser;
import win.naebka.common.Json;

/** Manual review queue and integrity dashboard (admin only; every action goes to the immutable audit log). */
@RestController
public class AdminController {
    private final JdbcClient jdbc;
    private final MatchService matches;
    private final SettlementService settlement;
    private final FallbackReportSource reportSources;
    private final StringRedisTemplate redis;

    public AdminController(JdbcClient jdbc, MatchService matches, SettlementService settlement,
                           FallbackReportSource reportSources, StringRedisTemplate redis) {
        this.jdbc = jdbc;
        this.matches = matches;
        this.settlement = settlement;
        this.reportSources = reportSources;
        this.redis = redis;
    }

    @GetMapping("/api/admin/review-queue")
    public List<MatchService.MatchView> reviewQueue() {
        List<UUID> ids = jdbc.sql("SELECT id FROM matches WHERE status = 'REVIEW' ORDER BY ended_at")
                .query(UUID.class).list();
        return ids.stream().map(matches::view).flatMap(java.util.Optional::stream).toList();
    }

    public record ResolveRequest(@NotNull @Min(1) @Max(2) Integer winnerSide, @NotNull @Min(0) Integer durationSeconds) {}

    @PostMapping("/api/admin/matches/{id}/settle")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    @Transactional
    public void settle(@PathVariable UUID id, @Valid @RequestBody ResolveRequest req) {
        settlement.settle(id, req.winnerSide(), req.durationSeconds());
        audit("MATCH_SETTLED_MANUALLY", id, Map.of("winnerSide", req.winnerSide(), "durationSeconds", req.durationSeconds()));
    }

    @PostMapping("/api/admin/matches/{id}/void")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    @Transactional
    public void voidMatch(@PathVariable UUID id) {
        settlement.voidMatch(id);
        audit("MATCH_VOIDED", id, Map.of());
    }

    public record PremiumRequest(@NotNull Boolean premium) {}

    /** Premium players may watch any live match on the realtime map. */
    @PostMapping("/api/admin/users/{id}/premium")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    @Transactional
    public void setPremium(@PathVariable UUID id, @Valid @RequestBody PremiumRequest req) {
        int n = jdbc.sql("UPDATE users SET premium = ?, updated_at = now() WHERE id = ?").params(req.premium(), id).update();
        if (n == 0) {
            throw new win.naebka.common.Exceptions.NotFoundException("User");
        }
        audit("USER_PREMIUM_SET", id, Map.of("premium", req.premium()));
    }

    @GetMapping("/api/admin/health")
    public Map<String, Object> health() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("watcherHeartbeat", redis.opsForValue().get("watcher:heartbeat"));
        out.put("oddsEngineHeartbeat", redis.opsForValue().get("odds-engine:heartbeat"));
        // Which live-match source the watcher used last: "deadlock-api" or "deadlock-bot".
        out.put("watcherSource", redis.opsForValue().get("watcher:source"));
        out.putAll(reportSources.health());
        // Broadcasts the Steam bot is following for the realtime map (deadlock-bot/src/feeds.rs).
        String feeds = redis.opsForValue().get("live:feeds");
        out.put("liveFeeds", feeds == null ? null : Json.read(feeds));
        out.put("matchesByStatus", jdbc.sql("SELECT status, count(*) FROM matches GROUP BY status")
                .query((rs, i) -> Map.entry(rs.getString(1), rs.getLong(2))).list().stream()
                .collect(java.util.stream.Collectors.toMap(Map.Entry::getKey, Map.Entry::getValue)));
        out.put("ledgerDrift", ledgerDrift());
        return out;
    }

    /** Reconciliation check (Risk #7): wallets whose balance differs from the sum of their ledger rows. */
    private List<Map<String, Object>> ledgerDrift() {
        return jdbc.sql("""
                SELECT w.id, w.balance, coalesce(sum(t.amount), 0) AS ledger
                FROM wallets w LEFT JOIN transactions t ON t.wallet_id = w.id
                GROUP BY w.id HAVING w.balance <> coalesce(sum(t.amount), 0)""")
                .query((rs, i) -> Map.<String, Object>of("walletId", rs.getObject(1), "balance", rs.getLong(2),
                        "ledger", rs.getLong(3)))
                .list();
    }

    private void audit(String action, UUID target, Map<String, Object> details) {
        jdbc.sql("INSERT INTO admin_audit_log (admin_id, action, target, details) VALUES (?, ?, ?, ?::jsonb)")
                .params(AuthUser.current().id(), action, target.toString(), Json.write(details)).update();
    }
}
