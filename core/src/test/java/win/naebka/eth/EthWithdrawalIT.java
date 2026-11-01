package win.naebka.eth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.TestPropertySource;
import org.web3j.crypto.ECKeyPair;
import org.web3j.crypto.Hash;
import org.web3j.crypto.Keys;
import org.web3j.crypto.SignedRawTransaction;
import org.web3j.crypto.TransactionDecoder;
import org.web3j.utils.Numeric;
import win.naebka.IntegrationTestBase;
import win.naebka.common.ErrorCode;
import win.naebka.common.Exceptions;
import win.naebka.common.Exceptions.DomainException;
import win.naebka.common.TxRetry;
import win.naebka.config.NaebkaProperties;
import win.naebka.wallet.WalletService;

/** Withdrawals to MetaMask against a fake chain: paid once, refunded only when the chain says it was not paid. */
@TestPropertySource(properties = {
        "naebka.eth.contract-address=" + EthTest.CONTRACT,
        "naebka.eth.operator-key=" + EthPayoutTest.OPERATOR_KEY,
        "naebka.eth.rpc-url=http://127.0.0.1:9",
        "naebka.eth.payout-initial-delay-ms=3600000", // the test drives the sender itself
})
class EthWithdrawalIT extends IntegrationTestBase {
    /** A chain that records what is sent and answers from fields the tests set. */
    static class FakeChain extends EthRpcClient {
        volatile long head = 100;
        volatile boolean paid;
        volatile RpcRejected estimateError;
        final List<String> broadcast = new CopyOnWriteArrayList<>();
        final Map<String, Receipt> receipts = new ConcurrentHashMap<>();

        FakeChain(NaebkaProperties props) {
            super(props);
        }

        @Override public long chainId() { return 11155111; }
        @Override public long blockNumber() { return head; }
        @Override public List<ChainDeposit> depositLogs(String contract, long from, long to) { return List.of(); }
        @Override public BigInteger pendingNonce(String address) { return BigInteger.valueOf(broadcast.size()); }
        @Override public BigInteger balance(String address) { return BigInteger.TEN.pow(18); }
        @Override public BigInteger baseFee() { return BigInteger.TEN.pow(9); }
        @Override public BigInteger maxPriorityFee() { return BigInteger.TEN.pow(9); }

        @Override
        public BigInteger estimateGas(String from, String to, String data) {
            if (estimateError != null) {
                throw estimateError;
            }
            return BigInteger.valueOf(80_000);
        }

        @Override
        public String ethCall(String to, String data) {
            return "0x" + "0".repeat(63) + (paid ? "1" : "0");
        }

        @Override
        public String sendRawTransaction(String rawHex) {
            broadcast.add(rawHex);
            return Hash.sha3(rawHex);
        }

        @Override
        public Optional<Receipt> receipt(String txHash) {
            return Optional.ofNullable(receipts.get(txHash));
        }

        void reset() {
            head = 100;
            paid = false;
            estimateError = null;
            broadcast.clear();
            receipts.clear();
        }
    }

    @TestConfiguration
    static class Chain {
        @Bean
        @Primary
        FakeChain fakeChain(NaebkaProperties props) {
            return new FakeChain(props);
        }
    }

    @Autowired
    FakeChain chain;
    @Autowired
    EthWithdrawalService withdrawals;
    @Autowired
    EthPayoutSender sender;
    @Autowired
    EthLinkService links;
    @Autowired
    WalletService wallets;
    @Autowired
    TxRetry tx;
    @Autowired
    JdbcClient jdbc;

    @BeforeEach
    void cleanChain() {
        chain.reset();
        // Payouts go one at a time across all users: park anything another test left open.
        jdbc.sql("UPDATE eth_withdrawals SET status = 'review' WHERE status IN ('pending', 'sent')").update();
    }

    private UUID verifiedUser() {
        UUID user = newUser();
        jdbc.sql("UPDATE users SET kyc_status = 'VERIFIED' WHERE id = ?").param(user).update();
        return user;
    }

    private String link(UUID user) throws Exception {
        ECKeyPair key = Keys.createEcKeyPair();
        String address = "0x" + Keys.getAddress(key);
        links.link(user, EthTest.personalSign(key, links.createLinkMessage(user, "player", address)));
        return address;
    }

    private EthWithdrawalService.Withdrawal request(UUID user, String tokens, String key) {
        return tx.inTransaction(() -> withdrawals.request(user, new BigDecimal(tokens), key));
    }

    private EthWithdrawalService.Withdrawal reload(UUID id) {
        return withdrawals.find(id).orElseThrow();
    }

    private long balance(UUID user) {
        return wallets.walletOf(user).balance();
    }

    @Test
    void aWithdrawalIsSignedSentAndConfirmedAfterEnoughBlocks() throws Exception {
        UUID user = verifiedUser();
        String address = link(user);
        long before = balance(user);

        var w = request(user, "100", "k1");
        assertThat(w.status()).isEqualTo("pending");
        assertThat(w.amountWei()).isEqualTo(new BigInteger("1000000000000000")); // 100 NTK = 0.001 ETH
        assertThat(balance(user)).isEqualTo(before - 10_000);

        sender.sendNext();
        w = reload(w.id());
        assertThat(w.status()).isEqualTo("sent");
        assertThat(chain.broadcast).hasSize(1);
        String raw = chain.broadcast.getFirst();
        assertThat(w.txHash()).isEqualTo(Hash.sha3(raw));
        var decoded = (SignedRawTransaction) TransactionDecoder.decode(raw);
        assertThat(decoded.getFrom()).isEqualTo(EthPayoutTest.OPERATOR_ADDRESS);
        assertThat(decoded.getTo()).isEqualTo(EthTest.CONTRACT);
        assertThat("0x" + decoded.getData()).isEqualTo(EthPayout.payoutCalldata(address, w.amountWei(), w.id()));

        sender.checkSent(); // not mined yet
        assertThat(reload(w.id()).status()).isEqualTo("sent");

        chain.receipts.put(w.txHash(), new EthRpcClient.Receipt(true, 100));
        sender.checkSent(); // 1 confirmation of 3
        assertThat(reload(w.id()).status()).isEqualTo("sent");

        chain.head = 102;
        sender.checkSent();
        assertThat(reload(w.id()).status()).isEqualTo("confirmed");
        assertThat(balance(user)).isEqualTo(before - 10_000);
    }

    @Test
    void theSameIdempotencyKeyMakesOneWithdrawal() throws Exception {
        UUID user = verifiedUser();
        link(user);
        long before = balance(user);
        var first = request(user, "50", "same");
        var again = request(user, "50", "same");
        assertThat(again.id()).isEqualTo(first.id());
        assertThat(balance(user)).isEqualTo(before - 5_000);
    }

    @Test
    void onlyOnePayoutIsInFlightAtATime() throws Exception {
        UUID user = verifiedUser();
        link(user);
        var a = request(user, "20", "a");
        var b = request(user, "20", "b");

        sender.sendNext();
        sender.sendNext();
        assertThat(chain.broadcast).hasSize(1);
        assertThat(reload(b.id()).status()).isEqualTo("pending");

        chain.receipts.put(reload(a.id()).txHash(), new EthRpcClient.Receipt(true, 98));
        sender.checkSent();
        sender.sendNext();
        assertThat(reload(a.id()).status()).isEqualTo("confirmed");
        assertThat(reload(b.id()).status()).isEqualTo("sent");
        assertThat(chain.broadcast).hasSize(2);
    }

    @Test
    void aRevertedPayoutIsRefunded() throws Exception {
        UUID user = verifiedUser();
        link(user);
        long before = balance(user);
        var w = request(user, "30", "r1");
        sender.sendNext();
        chain.receipts.put(reload(w.id()).txHash(), new EthRpcClient.Receipt(false, 90));

        sender.checkSent();
        assertThat(reload(w.id()).status()).isEqualTo("failed");
        assertThat(balance(user)).isEqualTo(before);
        sender.checkSent(); // refunded once only
        assertThat(balance(user)).isEqualTo(before);
    }

    @Test
    void aRevertForAnIdTheContractAlreadyPaidIsNotRefunded() throws Exception {
        UUID user = verifiedUser();
        link(user);
        long before = balance(user);
        var w = request(user, "30", "r2");
        sender.sendNext();
        chain.receipts.put(reload(w.id()).txHash(), new EthRpcClient.Receipt(false, 90));
        chain.paid = true;

        sender.checkSent();
        assertThat(reload(w.id()).status()).isEqualTo("confirmed");
        assertThat(balance(user)).isEqualTo(before - 3_000);
    }

    @Test
    void aPausedContractMakesThePayoutWaitWithoutSending() throws Exception {
        UUID user = verifiedUser();
        link(user);
        var w = request(user, "30", "p1");
        chain.estimateError = new EthRpcClient.RpcRejected("execution reverted", EthPayout.selector("IsPaused()"));

        sender.sendNext();
        w = reload(w.id());
        assertThat(w.status()).isEqualTo("pending");
        assertThat(w.error()).contains("paused");
        assertThat(chain.broadcast).isEmpty();
    }

    @Test
    void alreadyPaidOnChainIsConfirmedWithoutSending() throws Exception {
        UUID user = verifiedUser();
        link(user);
        var w = request(user, "30", "p2");
        chain.estimateError = new EthRpcClient.RpcRejected("execution reverted", EthPayout.selector("AlreadyPaid()"));
        sender.sendNext();
        assertThat(reload(w.id()).status()).isEqualTo("confirmed");
        assertThat(chain.broadcast).isEmpty();
    }

    @Test
    void requestsAreChecked() throws Exception {
        UUID unverified = newUser();
        link(unverified);
        assertThatThrownBy(() -> request(unverified, "100", "x"))
                .isInstanceOfSatisfying(DomainException.class, e -> assertThat(e.code()).isEqualTo(ErrorCode.KYC_REQUIRED));

        UUID unlinked = verifiedUser();
        assertThatThrownBy(() -> request(unlinked, "100", "x"))
                .isInstanceOfSatisfying(DomainException.class, e -> assertThat(e.code()).isEqualTo(ErrorCode.ETH_NOT_LINKED));

        UUID user = verifiedUser();
        link(user);
        assertThatThrownBy(() -> request(user, "1", "small")) // 0.00001 ETH: below the minimum
                .isInstanceOfSatisfying(DomainException.class, e -> assertThat(e.code()).isEqualTo(ErrorCode.INVALID_AMOUNT));
        assertThatThrownBy(() -> request(user, "6000", "big")) // above the contract's 0.05 ETH per payout
                .isInstanceOfSatisfying(DomainException.class, e -> assertThat(e.code()).isEqualTo(ErrorCode.INVALID_AMOUNT));
        long balance = balance(user);
        assertThatThrownBy(() -> request(user, new BigDecimal(balance).movePointLeft(2).add(BigDecimal.TEN).toPlainString(), "much"))
                .isInstanceOf(Exceptions.InsufficientBalanceException.class);
        assertThat(withdrawals.ofUser(user, 10)).isEmpty(); // the failed request left no row behind
    }

    @Test
    void anAdminCanRetryAWithdrawalInReview() throws Exception {
        UUID user = verifiedUser();
        link(user);
        var w = request(user, "30", "rv");
        sender.sendNext();
        jdbc.sql("UPDATE eth_withdrawals SET sent_at = now() - interval '2 hours' WHERE id = ?").param(w.id()).update();
        sender.checkSent();
        assertThat(reload(w.id()).status()).isEqualTo("review");

        assertThat(tx.inTransaction(() -> withdrawals.retry(w.id()))).isEqualTo("pending");
        sender.sendNext();
        assertThat(reload(w.id()).status()).isEqualTo("sent");
        assertThat(Numeric.cleanHexPrefix(reload(w.id()).txHash())).hasSize(64);
    }
}
