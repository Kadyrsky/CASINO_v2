package win.naebka.eth;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import win.naebka.common.ErrorCode;
import win.naebka.common.Exceptions;
import win.naebka.common.Exceptions.DomainException;
import win.naebka.common.Money;
import win.naebka.config.NaebkaProperties;
import win.naebka.kyc.KycService;
import win.naebka.wallet.LedgerSource;
import win.naebka.wallet.TxType;
import win.naebka.wallet.WalletService;

/**
 * Withdrawals to MetaMask. A request takes the tokens out of the ledger at once (so they can't be spent twice) and
 * stores a 'pending' withdrawal; {@link EthPayoutSender} then pays it on chain. A withdrawal that can never be paid
 * is 'failed' and its tokens come back. The contract's {@code paid[withdrawalId]} makes a double payment impossible
 * even if the same withdrawal is sent twice.
 */
@Service
public class EthWithdrawalService {
    private static final Logger log = LoggerFactory.getLogger(EthWithdrawalService.class);

    public record Withdrawal(UUID id, UUID userId, String toAddress, long amountMinor, BigInteger amountWei,
                             String status, Long nonce, String txHash, String rawTx, String error, int attempts,
                             Instant createdAt, Instant sentAt, Instant finishedAt) {}

    private final JdbcClient jdbc;
    private final WalletService wallets;
    private final KycService kyc;
    private final EthLinkService links;
    private final NaebkaProperties props;

    public EthWithdrawalService(JdbcClient jdbc, WalletService wallets, KycService kyc, EthLinkService links,
                                NaebkaProperties props) {
        this.jdbc = jdbc;
        this.wallets = wallets;
        this.kyc = kyc;
        this.links = links;
        this.props = props;
    }

    /** Smallest and largest withdrawal in tokens, from the contract's limits and the exchange rate. */
    public BigDecimal minTokens() {
        return Money.toTokens(Eth.weiToMinor(EthPayout.MIN_PAYOUT_WEI, props.eth().tokensPerEth()));
    }

    public BigDecimal maxTokens() {
        return Money.toTokens(Eth.weiToMinor(EthPayout.MAX_PAYOUT_WEI, props.eth().tokensPerEth()));
    }

    /**
     * Takes {@code amountTokens} from the player's wallet and queues the payout to their linked address. Replaying the
     * same {@code idempotencyKey} returns the first withdrawal instead of making another.
     */
    @Transactional(propagation = Propagation.MANDATORY)
    public Withdrawal request(UUID userId, BigDecimal amountTokens, String idempotencyKey) {
        var eth = props.eth();
        if (!eth.withdrawalsEnabled()) {
            throw new DomainException(ErrorCode.ETH_NOT_CONFIGURED,
                    "Withdrawals to MetaMask are off: the server has no operator key configured");
        }
        String key = "withdrawal:eth:" + userId + ":" + idempotencyKey;
        // Same lock as the ledger uses for this key, so two identical requests can't both get past the replay check.
        jdbc.sql("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))").param(key).query(Object.class).single();
        Optional<Withdrawal> replay = jdbc.sql(SELECT
                        + " WHERE id = (SELECT eth_withdrawal_id FROM transactions WHERE idempotency_key = ?)")
                .param(key).query(EthWithdrawalService::map).optional();
        if (replay.isPresent()) {
            return replay.get();
        }

        kyc.assertCanWithdraw(userId);
        String to = links.linkedAddress(userId).orElseThrow(() -> new DomainException(ErrorCode.ETH_NOT_LINKED,
                "Link a MetaMask address first: withdrawals go to your linked address"));
        long minor = Money.toMinor(amountTokens);
        BigInteger wei = EthPayout.minorToWei(minor, eth.tokensPerEth());
        if (minor <= 0 || wei.compareTo(EthPayout.MIN_PAYOUT_WEI) < 0 || wei.compareTo(EthPayout.MAX_PAYOUT_WEI) > 0) {
            throw new DomainException(ErrorCode.INVALID_AMOUNT,
                    "Withdraw between " + minTokens().toPlainString() + " and " + maxTokens().toPlainString() + " NTK");
        }

        UUID id = jdbc.sql("""
                INSERT INTO eth_withdrawals (user_id, chain_id, contract, to_address, amount_minor, amount_wei, status)
                VALUES (?, ?, ?, ?, ?, ?, 'pending') RETURNING id""")
                .params(userId, eth.chainId(), Eth.normalize(eth.contractAddress()), to, minor, new BigDecimal(wei))
                .query(UUID.class).single();
        // Throws (and rolls the row back) if the balance is too low.
        wallets.debit(wallets.walletIdOf(userId), minor, TxType.WITHDRAWAL, LedgerSource.ethWithdrawal(id), key);
        log.info("ETH withdrawal {} queued: {} NTK to {}", id, Money.toTokens(minor), to);
        return find(id).orElseThrow();
    }

    public Optional<Withdrawal> find(UUID id) {
        return jdbc.sql(SELECT + " WHERE id = ?").param(id).query(EthWithdrawalService::map).optional();
    }

    public List<Withdrawal> ofUser(UUID userId, int limit) {
        return jdbc.sql(SELECT + " WHERE user_id = ? ORDER BY created_at DESC LIMIT ?").params(userId, limit)
                .query(EthWithdrawalService::map).list();
    }

    /** Not finished yet (pending, sent, review), oldest first. */
    public List<Withdrawal> open(int limit) {
        return jdbc.sql(SELECT + " WHERE status IN ('pending', 'sent', 'review') ORDER BY created_at LIMIT ?")
                .param(limit).query(EthWithdrawalService::map).list();
    }

    // ---- state changes used by EthPayoutSender (each runs in the caller's transaction) ----

    /** The oldest pending withdrawal that is due, locked, unless one is already on its way (one at a time). */
    @Transactional(propagation = Propagation.MANDATORY)
    public Optional<Withdrawal> lockNextPending() {
        Integer inFlight = jdbc.sql("SELECT count(*) FROM eth_withdrawals WHERE status = 'sent' AND chain_id = ?")
                .param(props.eth().chainId()).query(Integer.class).single();
        if (inFlight > 0) {
            return Optional.empty();
        }
        return jdbc.sql(SELECT + """
                 WHERE status = 'pending' AND chain_id = ? AND next_try_at <= now()
                ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED""")
                .param(props.eth().chainId()).query(EthWithdrawalService::map).optional();
    }

    public List<Withdrawal> sent() {
        return jdbc.sql(SELECT + " WHERE status = 'sent' AND chain_id = ? ORDER BY sent_at")
                .param(props.eth().chainId()).query(EthWithdrawalService::map).list();
    }

    /** Saves the signed transaction before it is broadcast. False if the withdrawal is no longer pending. */
    @Transactional(propagation = Propagation.MANDATORY)
    public boolean markSent(UUID id, long nonce, EthPayout.SignedTx tx) {
        return jdbc.sql("""
                UPDATE eth_withdrawals SET status = 'sent', nonce = ?, tx_hash = ?, raw_tx = ?, error = NULL,
                       attempts = attempts + 1, sent_at = now()
                WHERE id = ? AND status = 'pending'""").params(nonce, tx.hash(), tx.rawHex(), id).update() > 0;
    }

    /** The node refused the transaction: sign it again (with a fresh nonce) later. */
    @Transactional(propagation = Propagation.MANDATORY)
    public void backToPending(UUID id, String error, int retryInSeconds) {
        jdbc.sql("""
                UPDATE eth_withdrawals SET status = 'pending', nonce = NULL, tx_hash = NULL, raw_tx = NULL, error = ?,
                       next_try_at = now() + make_interval(secs => ?)
                WHERE id = ? AND status IN ('pending', 'sent')""").params(error, retryInSeconds, id).update();
    }

    /** Can't be sent right now (paused, daily limit, contract short of ETH, gas too expensive): try again later. */
    @Transactional(propagation = Propagation.MANDATORY)
    public void postpone(UUID id, String error, int retryInSeconds) {
        jdbc.sql("""
                UPDATE eth_withdrawals SET error = ?, attempts = attempts + 1,
                       next_try_at = now() + make_interval(secs => ?)
                WHERE id = ? AND status = 'pending'""").params(error, retryInSeconds, id).update();
    }

    @Transactional(propagation = Propagation.MANDATORY)
    public void markConfirmed(UUID id, String note) {
        int n = jdbc.sql("""
                UPDATE eth_withdrawals SET status = 'confirmed', error = ?, finished_at = now()
                WHERE id = ? AND status IN ('pending', 'sent', 'review')""").params(note, id).update();
        if (n > 0) {
            log.info("ETH withdrawal {} confirmed{}", id, note == null ? "" : " (" + note + ")");
        }
    }

    @Transactional(propagation = Propagation.MANDATORY)
    public void markReview(UUID id, String error) {
        jdbc.sql("UPDATE eth_withdrawals SET status = 'review', error = ? WHERE id = ? AND status = 'sent'")
                .params(error, id).update();
        log.warn("ETH withdrawal {} needs an admin: {}", id, error);
    }

    /** It can never be paid: give the tokens back (once). */
    @Transactional(propagation = Propagation.MANDATORY)
    public void failAndRefund(UUID id, String error) {
        Withdrawal w = jdbc.sql(SELECT + " WHERE id = ? FOR UPDATE").param(id).query(EthWithdrawalService::map)
                .optional().orElseThrow(() -> new Exceptions.NotFoundException("ETH withdrawal"));
        if (!List.of("pending", "sent", "review").contains(w.status())) {
            return;
        }
        jdbc.sql("UPDATE eth_withdrawals SET status = 'failed', error = ?, finished_at = now() WHERE id = ?")
                .params(error, id).update();
        wallets.credit(wallets.walletIdOf(w.userId()), w.amountMinor(), TxType.ADJUSTMENT,
                LedgerSource.ethWithdrawal(id), "withdrawal-refund:eth:" + id);
        log.warn("ETH withdrawal {} failed, {} NTK refunded: {}", id, Money.toTokens(w.amountMinor()), error);
    }

    /** Admin: send a withdrawal in review again. The contract refuses to pay the same id twice. */
    @Transactional(propagation = Propagation.MANDATORY)
    public String retry(UUID id) {
        int n = jdbc.sql("""
                UPDATE eth_withdrawals SET status = 'pending', nonce = NULL, tx_hash = NULL, raw_tx = NULL,
                       next_try_at = now()
                WHERE id = ? AND status = 'review'""").param(id).update();
        return n > 0 ? "pending" : find(id).map(Withdrawal::status)
                .orElseThrow(() -> new Exceptions.NotFoundException("ETH withdrawal"));
    }

    private static final String SELECT = """
            SELECT id, user_id, to_address, amount_minor, amount_wei, status, nonce, tx_hash, raw_tx, error, attempts,
                   created_at, sent_at, finished_at
            FROM eth_withdrawals""";

    private static Withdrawal map(java.sql.ResultSet rs, int i) throws java.sql.SQLException {
        long nonce = rs.getLong("nonce");
        Long nonceOrNull = rs.wasNull() ? null : nonce;
        return new Withdrawal(rs.getObject("id", UUID.class), rs.getObject("user_id", UUID.class),
                rs.getString("to_address"), rs.getLong("amount_minor"),
                rs.getBigDecimal("amount_wei").toBigIntegerExact(), rs.getString("status"), nonceOrNull,
                rs.getString("tx_hash"), rs.getString("raw_tx"), rs.getString("error"), rs.getInt("attempts"),
                rs.getTimestamp("created_at").toInstant(), instant(rs, "sent_at"), instant(rs, "finished_at"));
    }

    private static Instant instant(java.sql.ResultSet rs, String column) throws java.sql.SQLException {
        var ts = rs.getTimestamp(column);
        return ts == null ? null : ts.toInstant();
    }
}
