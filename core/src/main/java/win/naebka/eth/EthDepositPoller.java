package win.naebka.eth;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import win.naebka.common.TxRetry;
import win.naebka.config.NaebkaProperties;

/**
 * Polls Sepolia for NaebkaCashier Deposited events and hands them to {@link EthDepositService}.
 *
 * <p>Only blocks at least {@code confirmations} deep are read (inclusion in one block is not finality). The events
 * of a block range and the new cursor are written in one transaction, so a crash re-reads that range and the
 * unique (chain, tx, log index) key makes the repeat a no-op. Nothing goes through Redis pub/sub here on purpose:
 * pub/sub drops messages while the core is down, and these are deposits.
 */
@Component
public class EthDepositPoller {
    private static final Logger log = LoggerFactory.getLogger(EthDepositPoller.class);
    /** Block ranges per tick, so catching up after downtime does not block the scheduler for long. */
    private static final int MAX_RANGES_PER_TICK = 20;

    private final EthRpcClient rpc;
    private final EthDepositService deposits;
    private final JdbcClient jdbc;
    private final TxRetry tx;
    private final NaebkaProperties props;

    private volatile Instant lastPollAt;
    private volatile Long lastHead;
    private volatile String lastError;
    private volatile Long rpcChainId;

    public EthDepositPoller(EthRpcClient rpc, EthDepositService deposits, JdbcClient jdbc, TxRetry tx,
                            NaebkaProperties props) {
        this.rpc = rpc;
        this.deposits = deposits;
        this.jdbc = jdbc;
        this.tx = tx;
        this.props = props;
    }

    @Scheduled(fixedDelayString = "${naebka.eth.poll-seconds}000", initialDelay = 20_000)
    public void poll() {
        if (!props.eth().configured()) {
            return;
        }
        try {
            pollOnce();
            lastError = null;
        } catch (RuntimeException e) {
            lastError = e.getMessage();
            log.warn("Sepolia deposit poll failed: {}", e.getMessage());
        } finally {
            lastPollAt = Instant.now();
        }
    }

    void pollOnce() {
        var eth = props.eth();
        String contract = Eth.normalize(eth.contractAddress());
        if (rpcChainId == null) {
            rpcChainId = rpc.chainId();
        }
        if (rpcChainId != eth.chainId()) {
            throw new IllegalStateException("RPC is on chain " + rpcChainId + ", expected " + eth.chainId()
                    + ". Check NAEBKA_ETH_RPC_URL.");
        }
        long head = rpc.blockNumber();
        lastHead = head;
        long safe = head - eth.confirmations();
        long cursor = loadCursor(contract).orElseGet(() -> eth.deployBlock() > 0
                ? eth.deployBlock() - 1
                : Math.max(0, safe - eth.maxBlockRange()));

        for (int i = 0; i < MAX_RANGES_PER_TICK && cursor < safe; i++) {
            long from = cursor + 1;
            long to = Math.min(safe, cursor + eth.maxBlockRange());
            List<EthRpcClient.ChainDeposit> logs = rpc.depositLogs(contract, from, to); // network call outside the tx
            tx.inTransaction(() -> {
                logs.forEach(d -> deposits.record(contract, d));
                saveCursor(contract, to);
                return null;
            });
            cursor = to;
        }
        tx.inTransaction(() -> {
            deposits.retryNewlyLinked();
            return null;
        });
    }

    public Map<String, Object> status() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("configured", props.eth().configured());
        out.put("chainId", props.eth().chainId());
        out.put("contractAddress", props.eth().contractAddress());
        out.put("lastPollAt", lastPollAt);
        out.put("headBlock", lastHead);
        if (props.eth().configured() && Eth.isAddress(props.eth().contractAddress())) {
            out.put("lastProcessedBlock", loadCursor(Eth.normalize(props.eth().contractAddress())).orElse(null));
        }
        out.put("lastError", lastError);
        return out;
    }

    private Optional<Long> loadCursor(String contract) {
        return jdbc.sql("SELECT last_block FROM chain_cursors WHERE chain_id = ? AND contract = ?")
                .params(props.eth().chainId(), contract).query(Long.class).optional();
    }

    private void saveCursor(String contract, long block) {
        jdbc.sql("""
                INSERT INTO chain_cursors (chain_id, contract, last_block) VALUES (?, ?, ?)
                ON CONFLICT (chain_id, contract) DO UPDATE SET last_block = EXCLUDED.last_block, updated_at = now()""")
                .params(props.eth().chainId(), contract, block).update();
    }
}
