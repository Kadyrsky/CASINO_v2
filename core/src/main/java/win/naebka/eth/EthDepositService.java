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
import win.naebka.common.Exceptions;
import win.naebka.common.Exceptions.DomainException;
import win.naebka.common.Money;
import win.naebka.config.NaebkaProperties;
import win.naebka.kyc.KycService;
import win.naebka.wallet.LedgerSource;
import win.naebka.wallet.ResponsibleGamingService;
import win.naebka.wallet.TxType;
import win.naebka.wallet.WalletService;

/**
 * Turns Deposited events into play tokens. Every event is stored once in eth_payments; it is credited through
 * {@link WalletService} (so the append-only ledger and idempotency rules apply) when its sender address is linked
 * to an account and the responsible-gambling and KYC deposit checks pass. Otherwise it waits as 'unlinked' or 'held'.
 * The ETH is already on chain, so a blocked deposit is kept, never refused.
 */
@Service
public class EthDepositService {
    private static final Logger log = LoggerFactory.getLogger(EthDepositService.class);

    public record Payment(UUID id, String txHash, int logIndex, long blockNumber, String fromAddress,
                          BigInteger amountWei, UUID userId, Long amountMinor, String status, String holdReason,
                          Instant createdAt) {}

    private final JdbcClient jdbc;
    private final WalletService wallets;
    private final ResponsibleGamingService rg;
    private final KycService kyc;
    private final NaebkaProperties props;

    public EthDepositService(JdbcClient jdbc, WalletService wallets, ResponsibleGamingService rg, KycService kyc,
                             NaebkaProperties props) {
        this.jdbc = jdbc;
        this.wallets = wallets;
        this.rg = rg;
        this.kyc = kyc;
        this.props = props;
    }

    /** Stores a Deposited event (no-op if already seen) and tries to credit it. Runs in the caller's transaction. */
    @Transactional(propagation = Propagation.MANDATORY)
    public void record(String contract, EthRpcClient.ChainDeposit d) {
        Optional<UUID> id = jdbc.sql("""
                INSERT INTO eth_payments (chain_id, contract, tx_hash, log_index, block_number, from_address,
                                          amount_wei, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'unlinked')
                ON CONFLICT (chain_id, tx_hash, log_index) DO NOTHING
                RETURNING id""")
                .params(props.eth().chainId(), contract, d.txHash(), d.logIndex(), d.blockNumber(), d.from(),
                        new BigDecimal(d.amountWei()))
                .query(UUID.class).optional();
        id.ifPresent(this::tryCredit);
    }

    /** Re-checks one stored payment and credits it if it can be credited now. Returns its resulting status. */
    @Transactional(propagation = Propagation.MANDATORY)
    public String tryCredit(UUID paymentId) {
        Payment p = jdbc.sql(SELECT + " WHERE id = ? FOR UPDATE").param(paymentId).query(EthDepositService::map)
                .optional().orElseThrow(() -> new Exceptions.NotFoundException("ETH deposit"));
        if ("credited".equals(p.status())) {
            return p.status();
        }
        Optional<UUID> user = jdbc.sql("SELECT user_id FROM wallet_addresses WHERE chain_id = ? AND address = ?")
                .params(props.eth().chainId(), p.fromAddress()).query(UUID.class).optional();
        if (user.isEmpty()) {
            setStatus(p.id(), null, null, "unlinked", null);
            return "unlinked";
        }
        UUID userId = user.get();
        long minor = Eth.weiToMinor(p.amountWei(), props.eth().tokensPerEth());
        String reason = null;
        if (minor <= 0) {
            reason = "The deposit is too small to convert to tokens";
        } else if (minor > props.wallet().maxDepositTokens() * 100) {
            reason = "Above the maximum single deposit of " + props.wallet().maxDepositTokens() + " tokens";
        } else {
            try {
                rg.assertCanDeposit(userId, minor);
                kyc.assertCanDeposit(userId, minor); // unverified accounts: lifetime deposit cap
            } catch (DomainException e) {
                reason = e.getMessage();
            }
        }
        if (reason != null) {
            setStatus(p.id(), userId, null, "held", reason);
            log.info("ETH deposit {} held for user {}: {}", p.txHash(), userId, reason);
            return "held";
        }
        String key = ledgerKey(props.eth().chainId(), p.txHash(), p.logIndex());
        wallets.credit(wallets.walletIdOf(userId), minor, TxType.DEPOSIT, LedgerSource.ethPayment(p.id()), key);
        jdbc.sql("""
                UPDATE eth_payments SET status = 'credited', user_id = ?, amount_minor = ?, hold_reason = NULL,
                                        credited_at = now()
                WHERE id = ?""").params(userId, minor, p.id()).update();
        log.info("ETH deposit {} credited {} NTK to user {}", p.txHash(), Money.toTokens(minor), userId);
        return "credited";
    }

    /**
     * Ledger idempotency key of an on-chain deposit. It starts with "deposit:" on purpose: KYC's lifetime deposit
     * cap counts DEPOSIT rows with that prefix (and so leaves out the signup bonus).
     */
    static String ledgerKey(long chainId, String txHash, int logIndex) {
        return "deposit:eth:" + chainId + ":" + txHash + ":" + logIndex;
    }

    /** Unlinked deposits whose sender has been linked since (covers a link that raced the poller). */
    @Transactional(propagation = Propagation.MANDATORY)
    public void retryNewlyLinked() {
        List<UUID> ids = jdbc.sql("""
                SELECT p.id FROM eth_payments p
                JOIN wallet_addresses a ON a.chain_id = p.chain_id AND a.address = p.from_address
                WHERE p.status = 'unlinked' AND p.chain_id = ?
                ORDER BY p.block_number, p.log_index LIMIT 100""")
                .param(props.eth().chainId()).query(UUID.class).list();
        ids.forEach(this::tryCredit);
    }

    /** Called right after an address is linked: credits what that address deposited before. */
    @Transactional(propagation = Propagation.MANDATORY)
    public void creditUnlinkedFrom(String address) {
        jdbc.sql("""
                SELECT id FROM eth_payments WHERE chain_id = ? AND from_address = ? AND status = 'unlinked'
                ORDER BY block_number, log_index""")
                .params(props.eth().chainId(), address).query(UUID.class).list()
                .forEach(this::tryCredit);
    }

    public List<Payment> ofUser(UUID userId, int limit) {
        return jdbc.sql(SELECT + """
                 WHERE chain_id = ? AND (user_id = ? OR from_address = (
                     SELECT address FROM wallet_addresses WHERE user_id = ? AND chain_id = ?))
                ORDER BY block_number DESC, log_index DESC LIMIT ?""")
                .params(props.eth().chainId(), userId, userId, props.eth().chainId(), limit)
                .query(EthDepositService::map).list();
    }

    public List<Payment> open(int limit) {
        return jdbc.sql(SELECT + " WHERE status <> 'credited' ORDER BY created_at DESC LIMIT ?")
                .param(limit).query(EthDepositService::map).list();
    }

    private void setStatus(UUID id, UUID userId, Long minor, String status, String reason) {
        jdbc.sql("UPDATE eth_payments SET status = ?, user_id = ?, amount_minor = ?, hold_reason = ? WHERE id = ?")
                .params(status, userId, minor, reason, id).update();
    }

    private static final String SELECT = """
            SELECT id, tx_hash, log_index, block_number, from_address, amount_wei, user_id, amount_minor, status,
                   hold_reason, created_at
            FROM eth_payments""";

    private static Payment map(java.sql.ResultSet rs, int i) throws java.sql.SQLException {
        long minor = rs.getLong("amount_minor");
        Long amountMinor = rs.wasNull() ? null : minor;
        return new Payment(rs.getObject("id", UUID.class), rs.getString("tx_hash"), rs.getInt("log_index"),
                rs.getLong("block_number"), rs.getString("from_address"),
                rs.getBigDecimal("amount_wei").toBigIntegerExact(), rs.getObject("user_id", UUID.class), amountMinor,
                rs.getString("status"), rs.getString("hold_reason"), rs.getTimestamp("created_at").toInstant());
    }
}
