package win.naebka.slots;

import static org.assertj.core.api.Assertions.assertThat;
import static win.naebka.slots.JackpotServiceTest.CLIENT_SEED;
import static win.naebka.slots.JackpotServiceTest.NONCE;
import static win.naebka.slots.JackpotServiceTest.SERVER_SEED;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.simple.JdbcClient;
import win.naebka.IntegrationTestBase;
import win.naebka.common.Money;
import win.naebka.slots.SlotService.SpinResult;
import win.naebka.wallet.WalletService;
import win.naebka.ws.TestSocket;

/**
 * The casino-wide jackpot against real PostgreSQL and Redis: every player's losing spins add up in the one pool, a hit
 * pays the whole pool and starts the next at the seed, many hits at once pay each pool exactly once, and everyone
 * watching sees the pool move and the win.
 */
class JackpotIT extends IntegrationTestBase {
    /** 0.10 NTK a line: 1.00 NTK a spin. */
    static final long BET_PER_LINE = 10;
    static final long STAKE = BET_PER_LINE * SlotMachine.paylineCount();

    @Autowired
    SlotService slots;
    @Autowired
    WalletService wallets;
    @Autowired
    JdbcClient jdbc;
    @LocalServerPort
    int port;

    record PoolRow(long amount, long seed, int bp, int generation) {}

    PoolRow pool() {
        return jdbc.sql("SELECT amount, seed_amount, contribution_bp, generation FROM jackpot_pools WHERE game_id = ?")
                .param(slots.defaultGameId())
                .query((rs, i) -> new PoolRow(rs.getLong(1), rs.getLong(2), rs.getInt(3), rs.getInt(4))).single();
    }

    void setPool(long amount) {
        jdbc.sql("UPDATE jackpot_pools SET amount = ? WHERE game_id = ?").params(amount, slots.defaultGameId()).update();
    }

    @AfterEach
    void backToTheSeed() {
        setPool(pool().seed());
    }

    /** The player's next spin lands five Hidden Kings on a line (JackpotServiceTest's seed pair). */
    void rigNextSpin(UUID user) {
        slots.fairness(user); // creates their seed pair
        jdbc.sql("""
                UPDATE fairness_seeds SET server_seed = ?, server_seed_hash = ?, client_seed = ?, nonce = ?
                WHERE user_id = ? AND active""")
                .params(SERVER_SEED, ProvablyFairRNG.sha256(SERVER_SEED), CLIENT_SEED, NONCE - 1, user).update();
    }

    /** A 1 NTK spin, after playing out the free spins or rift bonus the player's last spin left; all spins played. */
    List<SpinResult> spin(UUID user) {
        List<SpinResult> played = new ArrayList<>();
        SlotState state = slots.state(user).state();
        while (state != SlotState.IDLE) {
            if (state == SlotState.BONUS_GAME) {
                SlotService.BonusPickResult pick = null;
                for (int box = 0; pick == null || !pick.completed(); box++) {
                    pick = slots.playBonusTurn(user, box);
                }
                state = pick.nextState();
            } else {
                SpinResult free = slots.executeFreeSpin(user);
                played.add(free);
                state = free.nextState();
            }
        }
        played.add(slots.spin(user, BET_PER_LINE));
        return played;
    }

    /** What a spin should have added to the pool: 2% of what a paid spin lost, rounded up to a cent. */
    static long shareOf(SpinResult r, int bp) {
        if (r.freeSpin() || r.isBonusGameTriggered() || r.jackpotWin().signum() > 0) {
            return 0;
        }
        long loss = Money.toMinor(r.totalBet()) - Money.toMinor(r.totalWin());
        return loss <= 0 ? 0 : (loss * bp + 9_999) / 10_000;
    }

    /** Runs every task at the same moment (a start gate) and returns what each returned, in order. */
    static <T> List<T> allAtOnce(List<Callable<T>> tasks) throws Exception {
        ExecutorService threads = Executors.newFixedThreadPool(tasks.size());
        try {
            CountDownLatch gate = new CountDownLatch(1);
            List<Future<T>> futures = new ArrayList<>();
            for (Callable<T> task : tasks) {
                futures.add(threads.submit(() -> {
                    gate.await();
                    return task.call();
                }));
            }
            gate.countDown();
            List<T> out = new ArrayList<>();
            for (Future<T> f : futures) {
                out.add(f.get(60, TimeUnit.SECONDS));
            }
            return out;
        } finally {
            threads.shutdownNow();
        }
    }

    /**
     * Whatever happens in between, money is neither lost nor made: what was paid out plus what is left equals what the
     * pool started with, plus every share added to it, plus a seed for each pool that a hit started.
     */
    void assertPoolBalances(PoolRow before, List<SpinResult> results) {
        PoolRow after = pool();
        long shares = results.stream().mapToLong(r -> shareOf(r, before.bp())).sum();
        long paid = results.stream().mapToLong(r -> Money.toMinor(r.jackpotWin())).sum();
        long hits = results.stream().filter(r -> r.jackpotWin().signum() > 0).count();
        assertThat(paid + after.amount()).isEqualTo(before.amount() + shares + hits * before.seed());
        assertThat(after.generation()).isEqualTo(before.generation() + (int) hits);
    }

    @Test
    void everyonesLosingSpinsAddUpInTheOnePool() throws Exception {
        PoolRow before = pool();
        assertThat(before.bp()).isEqualTo(200);
        List<Callable<List<SpinResult>>> players = new ArrayList<>();
        for (int p = 0; p < 8; p++) {
            UUID user = newUser();
            players.add(() -> {
                List<SpinResult> mine = new ArrayList<>();
                for (int i = 0; i < 12; i++) {
                    mine.addAll(spin(user));
                }
                return mine;
            });
        }
        List<SpinResult> results = allAtOnce(players).stream().flatMap(List::stream).toList();

        assertPoolBalances(before, results);
        // Each spin that added to the pool says how much, and what the pool held right after it.
        List<SpinResult> losses = results.stream().filter(r -> shareOf(r, before.bp()) > 0).toList();
        assertThat(losses).hasSizeGreaterThan(8 * 12 / 2); // three paid spins in four lose
        for (SpinResult r : results) {
            long share = shareOf(r, before.bp());
            if (share > 0) {
                assertThat(Money.toMinor(r.jackpot().added())).isEqualTo(share);
            } else if (r.jackpotWin().signum() == 0) {
                assertThat(r.jackpot()).isNull();
            }
        }
        // The increments were serialized: no two spins saw the same pool.
        assertThat(losses.stream().map(r -> r.jackpot().amount()).distinct().count()).isEqualTo(losses.size());
    }

    @Test
    void aHitPaysTheWholePoolAndTheNextStartsAtTheSeed() {
        setPool(12_345_678); // 123,456.78 NTK
        PoolRow before = pool();
        UUID winner = newUser();
        rigNextSpin(winner);

        SpinResult r = slots.spin(winner, BET_PER_LINE);

        assertThat(Money.toMinor(r.jackpotWin())).isEqualTo(12_345_678);
        assertThat(Money.toMinor(r.totalWin())).isEqualTo(12_345_678); // the seed pair wins nothing else
        assertThat(Money.toMinor(r.balance())).isEqualTo(100_000 - STAKE + 12_345_678);
        assertThat(wallets.walletOf(winner).balance()).isEqualTo(100_000 - STAKE + 12_345_678);
        assertThat(r.jackpot().generation()).isEqualTo(before.generation() + 1);
        assertThat(Money.toMinor(r.jackpot().amount())).isEqualTo(before.seed());
        assertThat(pool()).isEqualTo(new PoolRow(before.seed(), before.seed(), before.bp(), before.generation() + 1));

        var win = jdbc.sql("SELECT generation, round_id, user_id, amount FROM jackpot_wins WHERE round_id = ?")
                .param(r.spinId())
                .query((rs, i) -> List.of(rs.getInt(1), rs.getObject(2), rs.getObject(3), rs.getLong(4))).single();
        assertThat(win).containsExactly(before.generation(), r.spinId(), winner, 12_345_678L);
        var paid = jdbc.sql("SELECT count(*) FROM transactions WHERE slot_round_id = ? AND type = 'JACKPOT_WIN' AND amount = ?")
                .params(r.spinId(), 12_345_678).query(Long.class).single();
        assertThat(paid).isEqualTo(1);

        JackpotService.JackpotView view = slots.jackpotView();
        assertThat(view.generation()).isEqualTo(before.generation() + 1);
        assertThat(view.lastWin().generation()).isEqualTo(before.generation());
        assertThat(Money.toMinor(view.lastWin().amount())).isEqualTo(12_345_678);
        assertThat(view.lastWin().winner()).matches(".\\*\\*\\*.");
        assertThat(view.contributionPercent()).isEqualByComparingTo("2");
    }

    @Test
    void manyHitsAtOnceStillPayEachPoolOnce() throws Exception {
        setPool(12_345_678);
        PoolRow before = pool();
        List<Callable<List<SpinResult>>> spins = new ArrayList<>();
        for (int p = 0; p < 6; p++) {
            UUID hitter = newUser();
            rigNextSpin(hitter);
            spins.add(() -> List.of(slots.spin(hitter, BET_PER_LINE)));
            UUID loser = newUser();
            spins.add(() -> {
                List<SpinResult> mine = new ArrayList<>();
                for (int i = 0; i < 4; i++) {
                    mine.addAll(spin(loser));
                }
                return mine;
            });
        }
        List<SpinResult> results = allAtOnce(spins).stream().flatMap(List::stream).toList();

        List<SpinResult> hits = results.stream().filter(r -> r.jackpotWin().signum() > 0).toList();
        assertThat(hits).hasSizeGreaterThanOrEqualTo(6);
        // One hit won the big pool; every other one won a pool that had just started at the seed.
        assertThat(hits.stream().filter(r -> Money.toMinor(r.jackpotWin()) >= 12_345_678)).hasSize(1);
        assertThat(hits.stream().filter(r -> Money.toMinor(r.jackpotWin()) < 12_345_678))
                .allSatisfy(r -> assertThat(Money.toMinor(r.jackpotWin())).isBetween(before.seed(), before.seed() + 1_000));
        assertPoolBalances(before, results);

        // A winner per pool, one pool after another, each for what its spin was paid.
        var wins = jdbc.sql("SELECT generation, round_id, amount FROM jackpot_wins WHERE generation >= ? ORDER BY generation")
                .param(before.generation())
                .query((rs, i) -> List.of(rs.getInt(1), rs.getObject(2), rs.getLong(3))).list();
        assertThat(wins).hasSize(hits.size());
        for (int i = 0; i < wins.size(); i++) {
            assertThat(wins.get(i).get(0)).isEqualTo(before.generation() + i);
        }
        assertThat(wins.stream().map(w -> List.of(w.get(1), w.get(2))))
                .containsExactlyInAnyOrderElementsOf(hits.stream()
                        .map(r -> List.<Object>of(r.spinId(), Money.toMinor(r.jackpotWin()))).toList());
    }

    @Test
    void everyoneWatchingSeesThePoolGrowAndTheWin() throws Exception {
        try (TestSocket watcher = new TestSocket(port, "/ws")) { // not logged in: the jackpot is public
            watcher.send(Map.of("op", "subscribe", "topic", JackpotService.TOPIC));
            watcher.await(f -> "SUBSCRIBED".equals(f.path("type").asText()));

            UUID player = newUser();
            SpinResult loss = null;
            while (loss == null) {
                loss = spin(player).stream().filter(r -> r.jackpot() != null).findFirst().orElse(null);
            }
            var grown = loss.jackpot();
            JsonNode tick = watcher.await(f -> "JACKPOT".equals(f.path("type").asText())
                    && f.path("data").path("generation").asInt() == grown.generation()
                    && f.path("data").path("amount").decimalValue().compareTo(grown.amount()) >= 0);
            assertThat(tick.path("topic").asText()).isEqualTo("jackpot");

            UUID winner = newUser();
            rigNextSpin(winner);
            SpinResult hit = slots.spin(winner, BET_PER_LINE);
            JsonNode won = watcher.awaitType("JACKPOT_WON").path("data");
            assertThat(won.path("generation").asInt()).isEqualTo(hit.jackpot().generation());
            assertThat(won.path("amount").decimalValue()).isEqualByComparingTo(hit.jackpot().amount());
            assertThat(won.path("lastWin").path("amount").decimalValue()).isEqualByComparingTo(hit.jackpotWin());
            assertThat(won.path("lastWin").path("generation").asInt()).isEqualTo(hit.jackpot().generation() - 1);
            assertThat(won.path("lastWin").path("winner").asText()).matches(".\\*\\*\\*.");
            assertThat(won.toString()).doesNotContain(winner.toString());
        }
    }
}
