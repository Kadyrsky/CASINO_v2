package win.naebka.eth;

import java.math.BigInteger;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.web3j.crypto.Credentials;
import win.naebka.common.TxRetry;
import win.naebka.config.NaebkaProperties;
import win.naebka.eth.EthRpcClient.RpcException;
import win.naebka.eth.EthRpcClient.RpcRejected;
import win.naebka.eth.EthWithdrawalService.Withdrawal;

/**
 * Pays pending withdrawals from the cashier contract with the operator key, one at a time.
 *
 * <p>Each tick first checks the withdrawal on its way: mined and {@code confirmations} deep means 'confirmed'; reverted
 * means 'failed' and refunded, unless the contract says the id was already paid; not mined after 5 minutes is
 * broadcast again; after an hour it goes to 'review' for an admin. Then it sends the next pending one: an
 * {@code eth_estimateGas} first shows whether the contract would accept it (paused, daily limit, not enough ETH in
 * the contract or the operator not set make it wait), the transaction is signed here, saved as 'sent' with its hash,
 * and only then broadcast. A crash after saving is harmless: the hash is known and the raw transaction is kept.
 */
@Component
public class EthPayoutSender {
    private static final Logger log = LoggerFactory.getLogger(EthPayoutSender.class);
    private static final Duration REBROADCAST_AFTER = Duration.ofMinutes(5);
    private static final Duration REVIEW_AFTER = Duration.ofMinutes(60);
    private static final BigInteger GWEI = BigInteger.TEN.pow(9);
    /** Used when the node doesn't support eth_maxPriorityFeePerGas. */
    private static final BigInteger DEFAULT_TIP = GWEI.multiply(BigInteger.valueOf(3)).divide(BigInteger.TWO);
    private static final BigInteger MIN_GAS = BigInteger.valueOf(60_000);

    private final EthRpcClient rpc;
    private final EthWithdrawalService withdrawals;
    private final TxRetry tx;
    private final NaebkaProperties props;

    private volatile Instant lastRunAt;
    private volatile String lastError;
    private volatile Credentials operator;

    public EthPayoutSender(EthRpcClient rpc, EthWithdrawalService withdrawals, TxRetry tx, NaebkaProperties props) {
        this.rpc = rpc;
        this.withdrawals = withdrawals;
        this.tx = tx;
        this.props = props;
    }

    @Scheduled(fixedDelayString = "${naebka.eth.poll-seconds}000",
            initialDelayString = "${naebka.eth.payout-initial-delay-ms:25000}")
    public void run() {
        if (!props.eth().withdrawalsEnabled()) {
            return;
        }
        try {
            checkSent();
            sendNext();
            lastError = null;
        } catch (RuntimeException e) {
            lastError = e.getMessage();
            log.warn("Sepolia payout run failed: {}", e.getMessage());
        } finally {
            lastRunAt = Instant.now();
        }
    }

    /** The operator account from the configured key. The key itself is never logged or returned. */
    Credentials operator() {
        Credentials c = operator;
        if (c == null) {
            try {
                c = Credentials.create(props.eth().operatorKey().trim());
            } catch (RuntimeException e) {
                throw new IllegalStateException("NAEBKA_ETH_OPERATOR_KEY is not a valid private key (0x + 64 hex digits)");
            }
            operator = c;
        }
        return c;
    }

    private String contract() {
        return Eth.normalize(props.eth().contractAddress());
    }

    void checkSent() {
        Long head = null;
        for (Withdrawal w : withdrawals.sent()) {
            Optional<EthRpcClient.Receipt> receipt = rpc.receipt(w.txHash());
            if (receipt.isEmpty()) {
                Duration age = Duration.between(w.sentAt(), Instant.now());
                if (age.compareTo(REVIEW_AFTER) > 0) {
                    tx.inTransaction(() -> {
                        withdrawals.markReview(w.id(), "Not mined after an hour. Check the transaction on Etherscan, "
                                + "then retry it from the admin page.");
                        return null;
                    });
                } else if (age.compareTo(REBROADCAST_AFTER) > 0) {
                    rebroadcast(w);
                }
                continue;
            }
            if (head == null) {
                head = rpc.blockNumber();
            }
            if (head - receipt.get().blockNumber() + 1 < props.eth().confirmations()) {
                continue; // mined, but not deep enough yet
            }
            boolean success = receipt.get().success();
            boolean paidBefore = !success && alreadyPaid(w);
            tx.inTransaction(() -> {
                if (success) {
                    withdrawals.markConfirmed(w.id(), null);
                } else if (paidBefore) {
                    withdrawals.markConfirmed(w.id(), "paid by an earlier transaction");
                } else {
                    withdrawals.failAndRefund(w.id(), "The payout transaction reverted: tokens refunded");
                }
                return null;
            });
        }
    }

    private boolean alreadyPaid(Withdrawal w) {
        return EthPayout.decodeBool(rpc.ethCall(contract(), EthPayout.paidCalldata(w.id())));
    }

    private void rebroadcast(Withdrawal w) {
        try {
            rpc.sendRawTransaction(w.rawTx());
            log.info("ETH withdrawal {} broadcast again ({})", w.id(), w.txHash());
        } catch (RpcRejected e) {
            if (said(e, "nonce too low")) {
                // Another transaction used the nonce, so this one can never be mined: sign it again. If it was ours
                // and did pay, the next attempt sees AlreadyPaid and marks it confirmed.
                tx.inTransaction(() -> {
                    withdrawals.backToPending(w.id(), "Replaced: its nonce was used by another transaction", 0);
                    return null;
                });
            } else if (!said(e, "already known", "known transaction")) {
                log.warn("Rebroadcast of ETH withdrawal {} refused: {}", w.id(), e.getMessage());
            }
        }
    }

    void sendNext() {
        Optional<Withdrawal> next = tx.inTransaction(withdrawals::lockNextPending);
        if (next.isEmpty()) {
            return;
        }
        Withdrawal w = next.get();
        Credentials op = operator();
        String contract = contract();
        String data = EthPayout.payoutCalldata(w.toAddress(), w.amountWei(), w.id());

        BigInteger gas;
        try {
            gas = rpc.estimateGas(op.getAddress(), contract, data);
        } catch (RpcRejected e) {
            onWouldRevert(w, e);
            return;
        }
        BigInteger gasLimit = gas.multiply(BigInteger.valueOf(5)).divide(BigInteger.valueOf(4)).max(MIN_GAS)
                .min(BigInteger.valueOf(props.eth().payoutGasLimit()));

        BigInteger tip = priorityFee();
        BigInteger cap = GWEI.multiply(BigInteger.valueOf(props.eth().maxFeeGwei()));
        BigInteger base = rpc.baseFee();
        BigInteger maxFee = base.multiply(BigInteger.TWO).add(tip).min(cap);
        if (maxFee.compareTo(base.add(tip)) < 0) {
            postpone(w, "Gas costs more than the " + props.eth().maxFeeGwei() + " gwei cap right now; waiting", 120);
            return;
        }

        BigInteger nonce = rpc.pendingNonce(op.getAddress());
        EthPayout.SignedTx signed = EthPayout.sign(op, props.eth().chainId(), nonce, contract, data, gasLimit, tip, maxFee);
        boolean saved = tx.inTransaction(() -> withdrawals.markSent(w.id(), nonce.longValueExact(), signed));
        if (!saved) {
            return; // changed meanwhile (an admin, or another instance)
        }
        try {
            rpc.sendRawTransaction(signed.rawHex());
            log.info("ETH withdrawal {} sent: {} wei to {} in {}", w.id(), w.amountWei(), w.toAddress(), signed.hash());
        } catch (RpcRejected e) {
            if (!said(e, "already known", "known transaction")) {
                tx.inTransaction(() -> {
                    withdrawals.backToPending(w.id(), "The node refused the transaction: " + e.getMessage(), 120);
                    return null;
                });
            }
        } catch (RpcException e) {
            // It may have arrived anyway: the receipt check and the rebroadcast sort it out.
            log.warn("Broadcast of ETH withdrawal {} uncertain: {}", w.id(), e.getMessage());
        }
    }

    private void onWouldRevert(Withdrawal w, RpcRejected e) {
        String name = EthPayout.errorName(e.data());
        tx.inTransaction(() -> {
            if ("AlreadyPaid".equals(name)) {
                withdrawals.markConfirmed(w.id(), "paid by an earlier transaction");
            } else if ("AmountOutOfRange".equals(name) || "ZeroAddress".equals(name)) {
                withdrawals.failAndRefund(w.id(), "The contract refuses this payout (" + name + "): tokens refunded");
            } else {
                withdrawals.postpone(w.id(), explain(name, e), 300);
            }
            return null;
        });
    }

    private void postpone(Withdrawal w, String why, int seconds) {
        tx.inTransaction(() -> {
            withdrawals.postpone(w.id(), why, seconds);
            return null;
        });
    }

    private BigInteger priorityFee() {
        try {
            return rpc.maxPriorityFee();
        } catch (RpcException e) {
            return DEFAULT_TIP;
        }
    }

    /** What an admin should do about a payout the contract would refuse. */
    static String explain(String errorName, RpcRejected e) {
        if (errorName == null) {
            String m = e.getMessage().toLowerCase(Locale.ROOT);
            if (m.contains("insufficient funds")) {
                return "The operator account has no Sepolia ETH for gas";
            }
            return "The payout would fail: " + e.getMessage();
        }
        return switch (errorName) {
            case "IsPaused" -> "The cashier contract is paused";
            case "DailyLimitReached" -> "The contract's daily payout limit is reached; it resets at 00:00 UTC";
            case "TransferFailed" -> "The cashier contract does not hold enough ETH: the owner should fund() it";
            case "OnlyOperator" -> "The server's account is not the contract's operator: the owner should setOperator()";
            default -> "The contract refuses the payout: " + errorName;
        };
    }

    private static boolean said(RpcException e, String... phrases) {
        String m = String.valueOf(e.getMessage()).toLowerCase(Locale.ROOT);
        for (String p : phrases) {
            if (m.contains(p)) {
                return true;
            }
        }
        return false;
    }

    /** For the admin page: the operator account, balances and the last run. */
    public Map<String, Object> status() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("enabled", props.eth().withdrawalsEnabled());
        out.put("lastRunAt", lastRunAt);
        out.put("lastError", lastError);
        if (!props.eth().withdrawalsEnabled()) {
            return out;
        }
        try {
            String address = operator().getAddress();
            out.put("operatorAddress", address);
            out.put("operatorBalanceEth", Eth.weiToEth(rpc.balance(address)));
            out.put("contractBalanceEth", Eth.weiToEth(rpc.balance(contract())));
            out.put("contractPaused", EthPayout.decodeBool(rpc.ethCall(contract(), EthPayout.PAUSED_CALLDATA)));
        } catch (RuntimeException e) {
            out.put("rpcError", e.getMessage());
        }
        return out;
    }
}
