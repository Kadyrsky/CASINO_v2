package win.naebka.wallet;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import win.naebka.common.Cursor;
import win.naebka.common.ErrorCode;
import win.naebka.common.Exceptions;
import win.naebka.common.Money;
import win.naebka.ws.WsHub;

/**
 * The wallet and its append-only ledger — the only code allowed to change wallets.balance.
 *
 * <p>Every balance change is a conditional UPDATE plus one ledger row in the caller's transaction
 * (Propagation.MANDATORY), so a stake debit can never land without its bet, round or hand. Debits use
 * {@code UPDATE ... WHERE balance >= :amount}; zero affected rows means insufficient funds and nothing
 * else in the transaction is applied (LLD §2.1, Risk #7). Each operation has an idempotency key: replays
 * return the original ledger row instead of moving money twice.
 */
@Service
public class WalletService {
    private final JdbcClient jdbc;
    private final WsHub ws;

    public WalletService(JdbcClient jdbc, WsHub ws) {
        this.jdbc = jdbc;
        this.ws = ws;
    }

    public record LedgerEntry(UUID id, UUID walletId, String type, long amount, long balanceAfter, UUID betId,
                              UUID slotRoundId, UUID pokerHandId, String idempotencyKey, Instant createdAt) {}

    public record WalletView(UUID walletId, String currency, long balance) {}

    @Transactional(propagation = Propagation.MANDATORY)
    public UUID createWallet(UUID userId, long initialMinor) {
        UUID walletId = jdbc.sql("""
                INSERT INTO wallets (user_id, currency_id)
                SELECT ?, id FROM currencies WHERE code = 'NTK' RETURNING id""")
                .param(userId).query(UUID.class).single();
        if (initialMinor > 0) {
            credit(walletId, initialMinor, TxType.DEPOSIT, LedgerSource.NONE, "signup-bonus:" + userId);
        }
        return walletId;
    }

    public WalletView walletOf(UUID userId) {
        return jdbc.sql("""
                SELECT w.id, c.code, w.balance FROM wallets w JOIN currencies c ON c.id = w.currency_id
                WHERE w.user_id = ? AND c.code = 'NTK'""")
                .param(userId)
                .query((rs, i) -> new WalletView(rs.getObject(1, UUID.class), rs.getString(2), rs.getLong(3)))
                .optional().orElseThrow(() -> new Exceptions.NotFoundException("Wallet"));
    }

    public UUID walletIdOf(UUID userId) {
        return walletOf(userId).walletId();
    }

    /** Takes {@code amountMinor} (> 0) out of the wallet or throws {@link Exceptions.InsufficientBalanceException}. */
    @Transactional(propagation = Propagation.MANDATORY)
    public LedgerEntry debit(UUID walletId, long amountMinor, TxType type, LedgerSource source, String idempotencyKey) {
        return apply(walletId, -requirePositive(amountMinor), type, source, idempotencyKey);
    }

    @Transactional(propagation = Propagation.MANDATORY)
    public LedgerEntry credit(UUID walletId, long amountMinor, TxType type, LedgerSource source, String idempotencyKey) {
        return apply(walletId, requirePositive(amountMinor), type, source, idempotencyKey);
    }

    private LedgerEntry apply(UUID walletId, long signedAmount, TxType type, LedgerSource source, String key) {
        // Serialize concurrent requests carrying the same idempotency key, then check for a replay.
        jdbc.sql("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))").param(key).query(Object.class).single();
        Optional<LedgerEntry> existing = findByKey(key);
        if (existing.isPresent()) {
            LedgerEntry e = existing.get();
            if (!e.walletId().equals(walletId) || e.amount() != signedAmount) {
                throw new Exceptions.DomainException(ErrorCode.IDEMPOTENCY_KEY_REUSED,
                        "Idempotency key was already used for a different operation");
            }
            return e;
        }

        record Updated(UUID userId, long balance) {}
        Optional<Updated> updated = jdbc.sql("""
                UPDATE wallets SET balance = balance + :amount, version = version + 1
                WHERE id = :id AND balance + :amount >= 0
                RETURNING user_id, balance""")
                .param("amount", signedAmount).param("id", walletId)
                .query((rs, i) -> new Updated(rs.getObject(1, UUID.class), rs.getLong(2)))
                .optional();
        if (updated.isEmpty()) {
            throw new Exceptions.InsufficientBalanceException();
        }

        LedgerEntry entry = jdbc.sql("""
                INSERT INTO transactions (wallet_id, type, amount, balance_after, bet_id, slot_round_id,
                                          poker_hand_id, btc_payment_id, eth_payment_id, idempotency_key)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                RETURNING id, wallet_id, type, amount, balance_after, bet_id, slot_round_id, poker_hand_id,
                          idempotency_key, created_at""")
                .params(walletId, type.name(), signedAmount, updated.get().balance(), source.betId(),
                        source.slotRoundId(), source.pokerHandId(), source.btcPaymentId(), source.ethPaymentId(), key)
                .query(WalletService::mapEntry).single();

        ws.publishToUser(updated.get().userId(), "WALLET_UPDATED",
                Map.of("balance", Money.toTokens(updated.get().balance()), "change", Money.toTokens(signedAmount),
                        "type", type.name()));
        return entry;
    }

    public Optional<LedgerEntry> findByKey(String key) {
        return jdbc.sql("""
                SELECT id, wallet_id, type, amount, balance_after, bet_id, slot_round_id, poker_hand_id,
                       idempotency_key, created_at
                FROM transactions WHERE idempotency_key = ?""")
                .param(key).query(WalletService::mapEntry).optional();
    }

    public Cursor.Page<LedgerEntry> history(UUID walletId, Cursor cursor, int limit) {
        String where = cursor == null ? "" : "AND (created_at, id) < (:at, :cid)";
        var spec = jdbc.sql("""
                SELECT id, wallet_id, type, amount, balance_after, bet_id, slot_round_id, poker_hand_id,
                       idempotency_key, created_at
                FROM transactions WHERE wallet_id = :wallet %s
                ORDER BY created_at DESC, id DESC LIMIT :limit""".formatted(where))
                .param("wallet", walletId).param("limit", limit + 1);
        if (cursor != null) {
            spec = spec.param("at", java.sql.Timestamp.from(cursor.at())).param("cid", cursor.id());
        }
        List<LedgerEntry> rows = spec.query(WalletService::mapEntry).list();
        return Cursor.Page.of(rows, limit, e -> new Cursor(e.createdAt(), e.id()));
    }

    private static LedgerEntry mapEntry(java.sql.ResultSet rs, int i) throws java.sql.SQLException {
        return new LedgerEntry(rs.getObject("id", UUID.class), rs.getObject("wallet_id", UUID.class),
                rs.getString("type"), rs.getLong("amount"), rs.getLong("balance_after"),
                rs.getObject("bet_id", UUID.class), rs.getObject("slot_round_id", UUID.class),
                rs.getObject("poker_hand_id", UUID.class), rs.getString("idempotency_key"),
                rs.getTimestamp("created_at").toInstant());
    }

    private static long requirePositive(long amount) {
        if (amount <= 0) {
            throw new Exceptions.DomainException(ErrorCode.INVALID_AMOUNT, "Amount must be positive");
        }
        return amount;
    }
}
