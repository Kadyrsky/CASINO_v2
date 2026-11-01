package win.naebka.live;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.math.BigDecimal;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;
import org.springframework.jdbc.core.simple.JdbcClient;
import win.naebka.IntegrationTestBase;
import win.naebka.common.ErrorCode;
import win.naebka.common.Exceptions;
import win.naebka.wallet.WalletService;

/** End-to-end simulated match flows: place → suspend → reprice → settle (Definition of Done). */
class LiveBettingFlowIT extends IntegrationTestBase {
    static final Map<String, MatchReportSource.MatchReport> REPORTS = new ConcurrentHashMap<>();

    @TestConfiguration
    static class FakeReports {
        @Bean
        @Primary
        MatchReportSource fakeReportSource() {
            return id -> Optional.ofNullable(REPORTS.get(id));
        }
    }

    @Autowired
    MatchService matches;
    @Autowired
    BetService bets;
    @Autowired
    SettlementService settlement;
    @Autowired
    WalletService wallets;
    @Autowired
    JdbcClient jdbc;

    UUID selection(UUID matchId, String key) {
        return jdbc.sql("""
                SELECT s.id FROM selections s JOIN markets m ON m.id = s.market_id
                WHERE m.match_id = ? AND s.outcome_key = ?""").params(matchId, key).query(UUID.class).single();
    }

    String marketStatus(UUID matchId) {
        return jdbc.sql("SELECT status FROM markets WHERE match_id = ? AND market_type = 'match_winner'")
                .param(matchId).query(String.class).single();
    }

    Exceptions.DomainException betFails(UUID user, UUID sel, String odds) {
        try {
            bets.place(user, sel, new BigDecimal("10"), odds == null ? null : new BigDecimal(odds), UUID.randomUUID().toString());
        } catch (Exceptions.DomainException e) {
            return e;
        }
        throw new AssertionError("bet should have failed");
    }

    @Test
    void fullMatchFlowPaysTheWinner() {
        MatchSimulator sim = new MatchSimulator(matches);
        UUID matchId = sim.discover();
        assertThat(marketStatus(matchId)).isEqualTo("SUSPENDED"); // awaiting first price
        UUID side1 = selection(matchId, "side1");
        UUID user = newUser();
        UUID loser = newUser();

        assertThat(betFails(user, side1, null).code()).isEqualTo(ErrorCode.MARKET_SUSPENDED);

        sim.price(null, "1.90", "1.90");
        assertThat(marketStatus(matchId)).isEqualTo("OPEN");
        var bet = bets.place(user, side1, new BigDecimal("100"), new BigDecimal("1.90"), "k1");
        assertThat(bet.status()).isEqualTo("PENDING");
        bets.place(loser, selection(matchId, "side2"), new BigDecimal("50"), null, "k2");
        assertThat(wallets.walletOf(user).balance()).isEqualTo(100_000 - 10_000);

        // Idempotent replay returns the same bet and does not debit twice.
        assertThat(bets.place(user, side1, new BigDecimal("100"), new BigDecimal("1.90"), "k1").id()).isEqualTo(bet.id());
        assertThat(wallets.walletOf(user).balance()).isEqualTo(90_000);

        // Courtsiding defense: state-changing event suspends before any new price exists.
        String event = sim.destroyObjective(1);
        assertThat(marketStatus(matchId)).isEqualTo("SUSPENDED");
        assertThat(betFails(user, side1, "1.90").code()).isEqualTo(ErrorCode.MARKET_SUSPENDED);

        // Reprice reopens; a client still holding the old price gets PRICE_CHANGED.
        sim.price(event, "1.60", "2.30");
        assertThat(marketStatus(matchId)).isEqualTo("OPEN");
        var changed = betFails(user, side1, "1.90");
        assertThat(changed.code()).isEqualTo(ErrorCode.PRICE_CHANGED);
        assertThat(changed.details()).containsEntry("currentOdds", new BigDecimal("1.60"));
        long history = jdbc.sql("SELECT count(*) FROM odds_history h JOIN selections s ON s.id = h.selection_id WHERE s.id = ?")
                .param(side1).query(Long.class).single();
        assertThat(history).isEqualTo(2);

        // Match ends; stream and official report agree → automatic settlement.
        sim.end(0);
        REPORTS.put(sim.externalId(), new MatchReportSource.MatchReport(1, 1500, false));
        settlement.processOne(new SettlementService.EndedMatch(matchId, sim.externalId(), 1, java.time.Instant.now(), 0));

        assertThat(jdbc.sql("SELECT status FROM matches WHERE id = ?").param(matchId).query(String.class).single())
                .isEqualTo("SETTLED");
        var settled = bets.findById(bet.id()).orElseThrow();
        assertThat(settled.status()).isEqualTo("WON");
        assertThat(settled.payout()).isEqualByComparingTo("190.00");
        assertThat(wallets.walletOf(user).balance()).isEqualTo(90_000 + 19_000);
        assertThat(wallets.walletOf(loser).balance()).isEqualTo(100_000 - 5_000);
        // Duration 25:00 → "under 30:00" won, "over" lost.
        assertThat(jdbc.sql("""
                SELECT s.result FROM selections s JOIN markets m ON m.id = s.market_id
                WHERE m.match_id = ? AND s.outcome_key = 'under'""").param(matchId).query(String.class).single())
                .isEqualTo("WON");
    }

    @Test
    void disagreeingSourcesGoToManualReviewAndVoidRefunds() {
        MatchSimulator sim = new MatchSimulator(matches);
        UUID matchId = sim.discover();
        sim.price(null, "1.90", "1.90");
        UUID user = newUser();
        bets.place(user, selection(matchId, "side2"), new BigDecimal("20"), null, "r1");

        sim.end(1); // stream says Archmother (side 2) won
        REPORTS.put(sim.externalId(), new MatchReportSource.MatchReport(1, 2000, false)); // report says side 1
        settlement.processOne(new SettlementService.EndedMatch(matchId, sim.externalId(), 2, java.time.Instant.now(), 0));
        assertThat(jdbc.sql("SELECT status FROM matches WHERE id = ?").param(matchId).query(String.class).single())
                .isEqualTo("REVIEW");
        assertThat(wallets.walletOf(user).balance()).isEqualTo(98_000); // nothing paid yet

        settlement.voidMatch(matchId);
        assertThat(wallets.walletOf(user).balance()).isEqualTo(100_000); // stake refunded
    }

    @Test
    void staleWatcherSuspendsMarkets() {
        MatchSimulator sim = new MatchSimulator(matches);
        UUID matchId = sim.discover();
        sim.price(null, "1.90", "1.90");
        jdbc.sql("UPDATE matches SET last_event_at = now() - interval '5 minutes' WHERE id = ?").param(matchId).update();
        assertThat(matches.markStale(60)).isGreaterThanOrEqualTo(1);
        assertThat(marketStatus(matchId)).isEqualTo("SUSPENDED");
        sim.snapshot(); // data flows again: match LIVE, market waits for a fresh price
        assertThat(jdbc.sql("SELECT status FROM matches WHERE id = ?").param(matchId).query(String.class).single())
                .isEqualTo("LIVE");
        assertThat(marketStatus(matchId)).isEqualTo("SUSPENDED");
    }

    @Test
    void implausibleOddsKeepTheMarketSuspended() {
        MatchSimulator sim = new MatchSimulator(matches);
        UUID matchId = sim.discover();
        sim.price(null, "1.00", "99.00");
        assertThat(marketStatus(matchId)).isEqualTo("SUSPENDED");
    }

    @Test
    void higherOddsCanBeAcceptedAutomaticallyButDropsNeverAre() {
        MatchSimulator sim = new MatchSimulator(matches);
        UUID matchId = sim.discover();
        sim.price(null, "1.90", "1.90");
        UUID user = newUser();
        UUID side1 = selection(matchId, "side1");
        sim.price(null, "2.10", "1.75"); // drifts up for side1 after the user saw 1.90
        var bet = bets.place(user, side1, new BigDecimal("10"), new BigDecimal("1.90"), true, "h1");
        assertThat(bet.odds()).isEqualByComparingTo("2.10");
        sim.price(null, "1.70", "2.20"); // drifts down
        assertThatThrownBy(() -> bets.place(user, side1, new BigDecimal("10"), new BigDecimal("2.10"), true, "h2"))
                .isInstanceOfSatisfying(Exceptions.DomainException.class, e -> assertThat(e.code()).isEqualTo(ErrorCode.PRICE_CHANGED));
    }

    @Test
    void stakeLimitsAreEnforced() {
        MatchSimulator sim = new MatchSimulator(matches);
        UUID matchId = sim.discover();
        sim.price(null, "1.90", "1.90");
        UUID user = newUser();
        assertThatThrownBy(() -> bets.place(user, selection(matchId, "side1"), new BigDecimal("0.50"), null, "s1"))
                .isInstanceOfSatisfying(Exceptions.DomainException.class, e -> assertThat(e.code()).isEqualTo(ErrorCode.STAKE_BELOW_MIN));
        assertThatThrownBy(() -> bets.place(user, selection(matchId, "side1"), new BigDecimal("999999"), null, "s2"))
                .isInstanceOfSatisfying(Exceptions.DomainException.class, e -> assertThat(e.code()).isEqualTo(ErrorCode.STAKE_ABOVE_MAX));
        assertThatThrownBy(() -> bets.place(user, selection(matchId, "side1"), new BigDecimal("4000"), null, "s3"))
                .isInstanceOf(Exceptions.InsufficientBalanceException.class);
    }
}
