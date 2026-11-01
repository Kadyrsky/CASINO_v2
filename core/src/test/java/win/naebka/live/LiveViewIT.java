package win.naebka.live;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.simple.JdbcClient;
import win.naebka.IntegrationTestBase;
import win.naebka.common.Json;

/** Live matches page and realtime map: who may watch, rosters with names and ranks, the directory endpoint. */
class LiveViewIT extends IntegrationTestBase {
    @Autowired
    MatchService matches;
    @Autowired
    BetService bets;
    @Autowired
    LiveViewPolicy policy;
    @Autowired
    LiveDirectoryController directory;
    @Autowired
    StringRedisTemplate redis;
    @Autowired
    JdbcClient jdbc;

    /** A tracked match with two players, priced so bets can be placed. */
    private UUID trackedMatch(String externalId) {
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("start_time", Instant.now().getEpochSecond());
        data.put("region", "europe");
        data.put("match_mode", 4);
        data.put("players", List.of(Map.of("account_id", 11, "team", 0, "hero_id", 7),
                Map.of("account_id", 22, "team", 1, "hero_id", 15)));
        data.put("state", Map.of("elapsed_s", 60, "net_worth", List.of(1000, 900), "objectives_alive", List.of(16, 16),
                "objectives_mask", List.of(0, 0), "spectators", 0));
        matches.applyEvent(new MatchEvent(UUID.randomUUID().toString(), MatchEvent.DISCOVERED, externalId, Instant.now(),
                Json.MAPPER.valueToTree(data)));
        matches.applyOddsUpdate(new OddsUpdate(externalId, null, List.of(
                new OddsUpdate.MarketPrice("match_winner", Map.of("side1", new BigDecimal("1.90"), "side2", new BigDecimal("1.90")), false))));
        return matches.findByExternalId(externalId).orElseThrow();
    }

    private UUID side1(UUID matchId) {
        return jdbc.sql("""
                SELECT s.id FROM selections s JOIN markets m ON m.id = s.market_id
                WHERE m.match_id = ? AND s.outcome_key = 'side1'""").param(matchId).query(UUID.class).single();
    }

    @Test
    void onlyAdminsPremiumPlayersAndBigEnoughBetsMayWatch() {
        String external = String.valueOf(System.nanoTime());
        UUID matchId = trackedMatch(external);
        UUID player = newUser();

        assertThat(policy.check(null, external).reason()).isEqualTo(LiveViewPolicy.Reason.LOGIN_REQUIRED);
        var none = policy.check(player, external);
        assertThat(none.allowed()).isFalse();
        assertThat(none.reason()).isEqualTo(LiveViewPolicy.Reason.STAKE_REQUIRED);
        assertThat(none.minStakeTokens()).isEqualByComparingTo("100");

        bets.place(player, side1(matchId), new BigDecimal("60"), null, UUID.randomUUID().toString());
        assertThat(policy.check(player, external).allowed()).isFalse();
        assertThat(policy.check(player, external).stakedTokens()).isEqualByComparingTo("60");
        bets.place(player, side1(matchId), new BigDecimal("40"), null, UUID.randomUUID().toString());
        assertThat(policy.check(player, external).reason()).isEqualTo(LiveViewPolicy.Reason.STAKE);

        UUID premium = newUser();
        jdbc.sql("UPDATE users SET premium = true WHERE id = ?").param(premium).update();
        assertThat(policy.check(premium, "123").reason()).isEqualTo(LiveViewPolicy.Reason.PREMIUM); // any match

        UUID admin = jdbc.sql("SELECT id FROM users WHERE role = 'ADMIN' LIMIT 1").query(UUID.class).single();
        assertThat(policy.check(admin, "123").reason()).isEqualTo(LiveViewPolicy.Reason.ADMIN);
    }

    @Test
    void theRosterIsStoredAndShownWithNamesAndRanks() {
        redis.opsForValue().set("naebka:pname:11", "{\"name\":\"Raiden\",\"avatar\":\"a.jpg\"}");
        redis.opsForValue().set("naebka:prank:11", "{\"badge\":105}");
        UUID matchId = trackedMatch(String.valueOf(System.nanoTime()));

        var view = matches.view(matchId).orElseThrow();
        assertThat(view.players()).hasSize(2);
        assertThat(view.players().get(0)).containsEntry("name", "Raiden").containsEntry("badge", 105)
                .containsEntry("hero_id", 7);
        assertThat(view.players().get(1)).containsEntry("name", null).containsEntry("badge", null);
        assertThat(view.meta().path("region").asText()).isEqualTo("europe");
    }

    @Test
    void theDirectoryLinksMatchesThatCanBeBetOn() {
        String external = String.valueOf(System.nanoTime());
        UUID matchId = trackedMatch(external);
        redis.opsForValue().set("live:directory", "{\"total\":1,\"rank_spread\":[],\"matches\":[{\"match_id\":\"" + external
                + "\",\"players\":[]}],\"updated_at\":1}");

        JsonNode d = directory.list();
        assertThat(d.path("total").asInt()).isEqualTo(1);
        assertThat(d.path("bettable").path(external).asText()).isEqualTo(matchId.toString());

        JsonNode one = directory.one(external);
        assertThat(one.path("bettableMatchId").asText()).isEqualTo(matchId.toString());
        assertThat(one.path("watch").path("reason").asText()).isEqualTo("LOGIN_REQUIRED");
    }

    @Test
    void wantedMatchesAreMarkedForTheBot() {
        policy.markWanted("4242");
        Double until = redis.opsForZSet().score("live:wanted", "4242");
        assertThat(until).isNotNull();
        assertThat(until).isGreaterThan((double) Instant.now().getEpochSecond());
        policy.markWanted("not-a-number");
        assertThat(redis.opsForZSet().score("live:wanted", "not-a-number")).isNull();
    }
}
