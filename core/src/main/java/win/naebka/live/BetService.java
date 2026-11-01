package win.naebka.live;

import java.math.BigDecimal;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import win.naebka.common.Cursor;
import win.naebka.common.ErrorCode;
import win.naebka.common.Exceptions;
import win.naebka.common.Exceptions.InvalidBetAmountException;
import win.naebka.common.Exceptions.MarketLockedException;
import win.naebka.common.Money;
import win.naebka.common.RateLimiter;
import win.naebka.common.TxRetry;
import win.naebka.config.NaebkaProperties;
import win.naebka.wallet.LedgerSource;
import win.naebka.wallet.ResponsibleGamingService;
import win.naebka.wallet.TxType;
import win.naebka.wallet.WalletService;
import win.naebka.ws.WsHub;

/**
 * Bet placement (BettingEngine.placeBet in the LLD). The client only sends selection + stake; the odds
 * are always the server's current price (never trusted from the client).
 *
 * <ol>
 *   <li>Validate stake bounds, rate limit, responsible-gambling limits.</li>
 *   <li>Snapshot market status and price_version; reject if not OPEN (409 MARKET_SUSPENDED).</li>
 *   <li>Wait the bet-acceptance delay (courtsiding defense).</li>
 *   <li>In one transaction: lock the market row, re-check status and price_version (409 PRICE_CHANGED if
 *       anything moved), insert the bet and debit the stake through the ledger.</li>
 * </ol>
 */
@Service
public class BetService {
    private final JdbcClient jdbc;
    private final WalletService wallets;
    private final ResponsibleGamingService rg;
    private final RateLimiter rateLimiter;
    private final TxRetry tx;
    private final WsHub ws;
    private final NaebkaProperties props;

    public BetService(JdbcClient jdbc, WalletService wallets, ResponsibleGamingService rg, RateLimiter rateLimiter,
                      TxRetry tx, WsHub ws, NaebkaProperties props) {
        this.jdbc = jdbc;
        this.wallets = wallets;
        this.rg = rg;
        this.rateLimiter = rateLimiter;
        this.tx = tx;
        this.ws = ws;
        this.props = props;
    }

    public record BetView(UUID id, UUID selectionId, String selectionName, String marketName, UUID matchId,
                          String matchExternalId, BigDecimal stake, BigDecimal odds, BigDecimal potentialPayout,
                          String status, BigDecimal payout, Instant placedAt, Instant settledAt) {}

    record Quote(UUID marketId, UUID matchId, String marketStatus, String matchStatus, long priceVersion, BigDecimal odds) {}

    public BetView place(UUID userId, UUID selectionId, BigDecimal stakeTokens, BigDecimal expectedOdds,
                         String idempotencyKey) {
        return place(userId, selectionId, stakeTokens, expectedOdds, false, idempotencyKey);
    }

    /**
     * @param acceptHigherOdds if the price rises between the user's click and acceptance, place the bet at the
     *                         new, better price instead of asking again (a drop always needs reconfirmation)
     */
    public BetView place(UUID userId, UUID selectionId, BigDecimal stakeTokens, BigDecimal expectedOdds,
                         boolean acceptHigherOdds, String idempotencyKey) {
        long stake = validateStake(stakeTokens);
        String key = "bet:" + userId + ":" + idempotencyKey;
        Optional<BetView> replay = findByKey(key);
        if (replay.isPresent()) {
            return replay.get();
        }
        rateLimiter.hit("bets:" + userId, props.betting().betsPerMinute(), Duration.ofMinutes(1));

        Quote before = quote(selectionId);
        assertOpen(before);
        BigDecimal floor = expectedOdds != null ? expectedOdds : before.odds();
        if (!acceptable(before.odds(), floor, acceptHigherOdds)) {
            throw priceChanged(before.odds());
        }
        rg.assertCanWager(userId, stake);

        sleep(props.betting().acceptanceDelayMs());

        UUID betId = tx.inTransaction(() -> {
            Quote now = lockedQuote(selectionId);
            assertOpen(now);
            boolean moved = now.priceVersion() != before.priceVersion() || now.odds().compareTo(before.odds()) != 0;
            if (moved && !(acceptHigherOdds && acceptable(now.odds(), floor, true))) {
                throw priceChanged(now.odds());
            }
            UUID walletId = wallets.walletIdOf(userId);
            UUID id = jdbc.sql("""
                    INSERT INTO bets (wallet_id, selection_id, stake, odds_at_placement, status, idempotency_key)
                    VALUES (?, ?, ?, ?, 'PENDING', ?) RETURNING id""")
                    .params(walletId, selectionId, stake, now.odds(), key).query(UUID.class).single();
            // Insufficient funds throws here and rolls the bet insert back with it.
            wallets.debit(walletId, stake, TxType.BET_STAKE, LedgerSource.bet(id), "bet-stake:" + id);
            return id;
        });
        BetView bet = findById(betId).orElseThrow();
        ws.publishToUser(userId, "BET_PLACED", bet);
        return bet;
    }

    private long validateStake(BigDecimal stakeTokens) {
        if (stakeTokens == null || stakeTokens.signum() <= 0) {
            throw new InvalidBetAmountException(ErrorCode.INVALID_AMOUNT, "Stake must be positive", Map.of());
        }
        long stake = Money.toMinor(stakeTokens);
        long min = props.betting().minStakeTokens() * 100;
        long max = props.betting().maxStakeTokens() * 100;
        if (stake < min) {
            throw new InvalidBetAmountException(ErrorCode.STAKE_BELOW_MIN, "Minimum stake is " + Money.toTokens(min),
                    Map.of("minStake", Money.toTokens(min)));
        }
        if (stake > max) {
            throw new InvalidBetAmountException(ErrorCode.STAKE_ABOVE_MAX, "Maximum stake is " + Money.toTokens(max),
                    Map.of("maxStake", Money.toTokens(max)));
        }
        return stake;
    }

    private static boolean acceptable(BigDecimal current, BigDecimal expected, boolean acceptHigher) {
        int cmp = current.compareTo(expected);
        return cmp == 0 || (acceptHigher && cmp > 0);
    }

    private static void assertOpen(Quote q) {
        if (!"LIVE".equals(q.matchStatus())) {
            throw new MarketLockedException(ErrorCode.MARKET_CLOSED, "Match is not live");
        }
        switch (q.marketStatus()) {
            case "OPEN" -> {
                if (q.odds() == null) {
                    throw new MarketLockedException(ErrorCode.MARKET_SUSPENDED, "Market has no price yet");
                }
            }
            case "SUSPENDED" -> throw new MarketLockedException(ErrorCode.MARKET_SUSPENDED,
                    "Market is suspended while odds are recalculated");
            default -> throw new MarketLockedException(ErrorCode.MARKET_CLOSED, "Market is closed");
        }
    }

    private static Exceptions.DomainException priceChanged(BigDecimal newOdds) {
        return new Exceptions.DomainException(ErrorCode.PRICE_CHANGED,
                "The price changed, please confirm the new odds", newOdds == null ? Map.of() : Map.of("currentOdds", newOdds));
    }

    private Quote quote(UUID selectionId) {
        return jdbc.sql("""
                SELECT mk.id, mk.match_id, mk.status, m.status, mk.price_version, s.odds
                FROM selections s JOIN markets mk ON mk.id = s.market_id JOIN matches m ON m.id = mk.match_id
                WHERE s.id = ?""")
                .param(selectionId).query(BetService::mapQuote).optional()
                .orElseThrow(() -> new Exceptions.NotFoundException("Selection"));
    }

    /** Same as {@link #quote} but holds a share lock on the market, so no reprice can commit under us. */
    private Quote lockedQuote(UUID selectionId) {
        return jdbc.sql("""
                SELECT mk.id, mk.match_id, mk.status, m.status, mk.price_version, s.odds
                FROM selections s JOIN markets mk ON mk.id = s.market_id JOIN matches m ON m.id = mk.match_id
                WHERE s.id = ? FOR SHARE OF mk""")
                .param(selectionId).query(BetService::mapQuote).single();
    }

    private static Quote mapQuote(java.sql.ResultSet rs, int i) throws java.sql.SQLException {
        return new Quote(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class), rs.getString(3), rs.getString(4),
                rs.getLong(5), rs.getBigDecimal(6));
    }

    private static final String BET_SELECT = """
            SELECT b.id, b.selection_id, s.name AS sel_name, mk.name AS market_name, m.id AS match_id,
                   m.external_id, b.stake, b.odds_at_placement, b.status, b.payout, b.placed_at, b.settled_at
            FROM bets b JOIN selections s ON s.id = b.selection_id JOIN markets mk ON mk.id = s.market_id
            JOIN matches m ON m.id = mk.match_id
            """;

    private static BetView mapBet(java.sql.ResultSet rs, int i) throws java.sql.SQLException {
        long stake = rs.getLong("stake");
        BigDecimal odds = rs.getBigDecimal("odds_at_placement");
        var settled = rs.getTimestamp("settled_at");
        return new BetView(rs.getObject("id", UUID.class), rs.getObject("selection_id", UUID.class),
                rs.getString("sel_name"), rs.getString("market_name"), rs.getObject("match_id", UUID.class),
                rs.getString("external_id"), Money.toTokens(stake), odds, Money.toTokens(Money.payout(stake, odds)),
                rs.getString("status"), Money.toTokens(rs.getLong("payout")), rs.getTimestamp("placed_at").toInstant(),
                settled == null ? null : settled.toInstant());
    }

    public Optional<BetView> findById(UUID id) {
        return jdbc.sql(BET_SELECT + " WHERE b.id = ?").param(id).query(BetService::mapBet).optional();
    }

    private Optional<BetView> findByKey(String key) {
        return jdbc.sql(BET_SELECT + " WHERE b.idempotency_key = ?").param(key).query(BetService::mapBet).optional();
    }

    public Cursor.Page<BetView> myBets(UUID userId, Cursor cursor, int limit) {
        String where = cursor == null ? "" : "AND (b.placed_at, b.id) < (:at, :cid)";
        var spec = jdbc.sql(BET_SELECT + """
                JOIN wallets w ON w.id = b.wallet_id
                WHERE w.user_id = :user %s ORDER BY b.placed_at DESC, b.id DESC LIMIT :limit""".formatted(where))
                .param("user", userId).param("limit", limit + 1);
        if (cursor != null) {
            spec = spec.param("at", java.sql.Timestamp.from(cursor.at())).param("cid", cursor.id());
        }
        List<BetView> rows = spec.query(BetService::mapBet).list();
        return Cursor.Page.of(rows, limit, b -> new Cursor(b.placedAt(), b.id()));
    }

    private static void sleep(long ms) {
        if (ms <= 0) {
            return;
        }
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
