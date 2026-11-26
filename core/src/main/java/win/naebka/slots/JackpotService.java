package win.naebka.slots;

import java.math.BigDecimal;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import win.naebka.common.Money;

/**
 * The casino-wide progressive jackpot: one pool per slot game (jackpot_pools), shared by everyone who plays it.
 *
 * <p>Every losing paid spin, by anyone, adds {@code contribution_bp} of what it lost (its stake minus its win, rounded
 * up to a cent, so every loss adds something). Five Hidden Kings on a line ({@link SpinPayout#jackpotHit()}) win the
 * whole pool, and the next pool starts at the seed. Pools are numbered ({@code generation}); each has exactly one
 * winner, which jackpot_wins' primary key enforces.
 *
 * <p>Both happen inside the spin's transaction, so the stake, the round, the payout and the pool commit together or
 * not at all. A contribution is a single atomic UPDATE, made last in the spin, so the casino-wide row stays locked for
 * as short a time as possible. A hit locks the row before reading it (SELECT ... FOR UPDATE waits for any spin still
 * holding it, then reads the latest amount), so two hits can never pay the same pool: the second one waits for the
 * first to commit and then wins the next pool. A plain UPDATE ... FROM self-join would read the amount from before
 * the wait and pay that pool twice.
 */
@Service
public class JackpotService {
    /** WebSocket topic everyone can subscribe to: JACKPOT ticks and JACKPOT_WON (JackpotFeed). */
    public static final String TOPIC = "jackpot";

    private final JdbcClient jdbc;
    private final JackpotFeed feed;

    public JackpotService(JdbcClient jdbc, JackpotFeed feed) {
        this.jdbc = jdbc;
        this.feed = feed;
    }

    /** A pool as it is stored, in minor units. */
    public record Pool(UUID gameId, long amount, long seedAmount, int contributionBp, int generation) {}

    /** A hit: the pool that was won, and the one that starts in its place. */
    public record Claim(Pool won, Pool next) {}

    /** The pool after a spin that changed it, and what that spin added (0 for the hit that reset it). */
    public record JackpotChange(BigDecimal amount, int generation, BigDecimal added) {}

    public record JackpotWinView(BigDecimal amount, int generation, String winner, Instant at) {}

    public record JackpotView(BigDecimal amount, int generation, BigDecimal seed, BigDecimal contributionPercent,
                              JackpotWinView lastWin) {}

    private static final String COLUMNS = "game_id, amount, seed_amount, contribution_bp, generation";

    private static Pool pool(ResultSet rs, int i) throws SQLException {
        return new Pool(rs.getObject("game_id", UUID.class), rs.getLong("amount"), rs.getLong("seed_amount"),
                rs.getInt("contribution_bp"), rs.getInt("generation"));
    }

    /**
     * What a spin lost, as far as the jackpot is concerned: the stake minus the win, when a paid spin won less than it
     * cost. A free spin cost nothing; a spin that hits the jackpot or opens the rift bonus (whose win comes later) has
     * lost nothing.
     */
    public static long lossOf(SpinPayout payout, long stake, boolean free) {
        if (free || payout.jackpotHit() || payout.bonusTriggered()) {
            return 0;
        }
        return Math.max(0, stake - payout.totalWin());
    }

    /** A losing spin's share. Call it last in the spin: the casino-wide row stays locked until the spin commits. */
    @Transactional(propagation = Propagation.MANDATORY)
    public Optional<JackpotChange> contribute(UUID gameId, long loss) {
        if (loss <= 0) {
            return Optional.empty();
        }
        record Added(Pool pool, long added) {}
        Added a = jdbc.sql("""
                UPDATE jackpot_pools SET amount = amount + (:loss * contribution_bp + 9999) / 10000, updated_at = now()
                WHERE game_id = :game
                RETURNING %s, (:loss * contribution_bp + 9999) / 10000 AS added""".formatted(COLUMNS))
                .param("loss", loss).param("game", gameId)
                .query((rs, i) -> new Added(pool(rs, i), rs.getLong("added"))).single();
        afterCommit(() -> feed.offer(a.pool()));
        return Optional.of(change(a.pool(), a.added()));
    }

    /**
     * Takes the whole pool for a hit and starts the next one at the seed. The caller pays {@code won().amount()} and
     * then calls {@link #recordWin}, in the same transaction.
     */
    @Transactional(propagation = Propagation.MANDATORY)
    public Claim claim(UUID gameId) {
        Pool won = jdbc.sql("SELECT %s FROM jackpot_pools WHERE game_id = ? FOR UPDATE".formatted(COLUMNS))
                .param(gameId).query(JackpotService::pool).single();
        Pool next = jdbc.sql("""
                UPDATE jackpot_pools SET amount = seed_amount, generation = generation + 1, updated_at = now()
                WHERE game_id = ? RETURNING %s""".formatted(COLUMNS))
                .param(gameId).query(JackpotService::pool).single();
        return new Claim(won, next);
    }

    /** Records who won a claimed pool with which round, and tells everyone once the spin commits. */
    @Transactional(propagation = Propagation.MANDATORY)
    public JackpotWinView recordWin(Claim claim, UUID roundId, UUID userId) {
        Instant at = jdbc.sql("""
                INSERT INTO jackpot_wins (game_id, generation, round_id, user_id, amount) VALUES (?, ?, ?, ?, ?)
                RETURNING won_at""")
                .params(claim.won().gameId(), claim.won().generation(), roundId, userId, claim.won().amount())
                .query((rs, i) -> rs.getTimestamp(1).toInstant()).single();
        String username = jdbc.sql("SELECT username FROM users WHERE id = ?").param(userId).query(String.class).single();
        JackpotWinView win = new JackpotWinView(Money.toTokens(claim.won().amount()), claim.won().generation(),
                maskName(username), at);
        feed.announce(claim.next(), win); // WsHub sends it after the commit
        afterCommit(() -> feed.offer(claim.next()));
        return win;
    }

    public JackpotView view(UUID gameId) {
        Pool p = jdbc.sql("SELECT %s FROM jackpot_pools WHERE game_id = ?".formatted(COLUMNS)).param(gameId)
                .query(JackpotService::pool).single();
        JackpotWinView last = jdbc.sql("""
                SELECT j.amount, j.generation, u.username, j.won_at FROM jackpot_wins j JOIN users u ON u.id = j.user_id
                WHERE j.game_id = ? ORDER BY j.generation DESC LIMIT 1""")
                .param(gameId)
                .query((rs, i) -> new JackpotWinView(Money.toTokens(rs.getLong(1)), rs.getInt(2),
                        maskName(rs.getString(3)), rs.getTimestamp(4).toInstant()))
                .optional().orElse(null);
        return new JackpotView(Money.toTokens(p.amount()), p.generation(), Money.toTokens(p.seedAmount()),
                BigDecimal.valueOf(p.contributionBp(), 2), last);
    }

    static JackpotChange change(Pool pool, long added) {
        return new JackpotChange(Money.toTokens(pool.amount()), pool.generation(), Money.toTokens(added));
    }

    /** How a winner is shown to everyone else: first and last letter only ("l***n"). */
    public static String maskName(String username) {
        if (username == null || username.isBlank()) {
            return "someone";
        }
        String u = username.strip();
        int first = u.codePointAt(0);
        int last = u.codePointBefore(u.length());
        return u.codePointCount(0, u.length()) < 3 ? Character.toString(first) + "***"
                : Character.toString(first) + "***" + Character.toString(last);
    }

    private static void afterCommit(Runnable action) {
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override
            public void afterCommit() {
                action.run();
            }
        });
    }
}
