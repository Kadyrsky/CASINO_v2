package win.naebka.eth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.math.BigInteger;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.TestPropertySource;
import org.web3j.crypto.ECKeyPair;
import org.web3j.crypto.Keys;
import win.naebka.IntegrationTestBase;
import win.naebka.common.ErrorCode;
import win.naebka.common.Exceptions.DomainException;
import win.naebka.common.TxRetry;
import win.naebka.wallet.ResponsibleGamingService;
import win.naebka.wallet.WalletService;

/** Deposits from chain events: credited exactly once, held or waiting when they cannot be credited yet. */
@TestPropertySource(properties = {
        "naebka.eth.contract-address=" + EthTest.CONTRACT,
        "naebka.eth.rpc-url=http://127.0.0.1:9", // the poller must not reach a real chain in tests
})
class EthDepositIT extends IntegrationTestBase {
    @Autowired
    EthDepositService deposits;
    @Autowired
    EthLinkService links;
    @Autowired
    WalletService wallets;
    @Autowired
    ResponsibleGamingService rg;
    @Autowired
    TxRetry tx;
    @Autowired
    JdbcClient jdbc;

    static final BigInteger MILLI_ETH = new BigInteger("1000000000000000"); // 0.001 ETH = 100.00 NTK

    private String linkNewKey(UUID user) throws Exception {
        ECKeyPair key = Keys.createEcKeyPair();
        String address = "0x" + Keys.getAddress(key);
        String message = links.createLinkMessage(user, "player", address);
        assertThat(links.link(user, EthTest.personalSign(key, message))).isEqualTo(address);
        return address;
    }

    private void deposit(String from, String txHash, BigInteger wei) {
        tx.inTransaction(() -> {
            deposits.record(EthTest.CONTRACT, new EthRpcClient.ChainDeposit(txHash, 0, 1, from, wei));
            return null;
        });
    }

    private static String hash() {
        return "0x" + (UUID.randomUUID().toString() + UUID.randomUUID()).replace("-", "");
    }

    private long balance(UUID user) {
        return wallets.walletOf(user).balance();
    }

    @Test
    void linkedDepositIsCreditedOnceEvenWhenSeenTwice() throws Exception {
        UUID user = newUser();
        String address = linkNewKey(user);
        long before = balance(user);
        String txHash = hash();

        deposit(address, txHash, MILLI_ETH);
        deposit(address, txHash, MILLI_ETH); // the poller re-reads a range after a crash

        assertThat(balance(user)).isEqualTo(before + 10_000);
        assertThat(jdbc.sql("SELECT status FROM eth_payments WHERE tx_hash = ?").param(txHash).query(String.class).single())
                .isEqualTo("credited");
        assertThat(jdbc.sql("SELECT count(*) FROM transactions WHERE eth_payment_id IS NOT NULL AND idempotency_key LIKE ?")
                .param("%" + txHash + "%").query(Long.class).single()).isEqualTo(1);
    }

    @Test
    void depositBeforeLinkingIsCreditedWhenTheAddressIsLinked() throws Exception {
        ECKeyPair key = Keys.createEcKeyPair();
        String address = "0x" + Keys.getAddress(key);
        String txHash = hash();
        deposit(address, txHash, MILLI_ETH);
        assertThat(jdbc.sql("SELECT status FROM eth_payments WHERE tx_hash = ?").param(txHash).query(String.class).single())
                .isEqualTo("unlinked");

        UUID user = newUser();
        long before = balance(user);
        links.link(user, EthTest.personalSign(key, links.createLinkMessage(user, "player", address)));

        assertThat(balance(user)).isEqualTo(before + 10_000);
    }

    @Test
    void depositOverTheDepositLimitIsHeldNotCredited() throws Exception {
        UUID user = newUser();
        String address = linkNewKey(user);
        tx.inTransaction(() -> {
            rg.setLimit(user, "deposit", "daily", 100_000); // the 1,000 NTK signup bonus already used it up
            return null;
        });
        long before = balance(user);
        String txHash = hash();

        deposit(address, txHash, MILLI_ETH);

        assertThat(balance(user)).isEqualTo(before);
        assertThat(jdbc.sql("SELECT status FROM eth_payments WHERE tx_hash = ?").param(txHash).query(String.class).single())
                .isEqualTo("held");
    }

    @Test
    void unverifiedAccountOverTheKycCapIsHeldAndTheCapCountsSepoliaDeposits() throws Exception {
        UUID user = newUser(); // KYC status NONE: lifetime deposits capped at 2,000 NTK (signup bonus excluded)
        String address = linkNewKey(user);
        long before = balance(user);

        deposit(address, hash(), MILLI_ETH.multiply(BigInteger.valueOf(15))); // 1,500 NTK: under the cap
        String overCap = hash();
        deposit(address, overCap, MILLI_ETH.multiply(BigInteger.valueOf(6))); // +600 NTK would make 2,100

        assertThat(balance(user)).isEqualTo(before + 150_000);
        assertThat(jdbc.sql("SELECT status FROM eth_payments WHERE tx_hash = ?").param(overCap).query(String.class).single())
                .isEqualTo("held");
    }

    @Test
    void anAddressCanOnlyBelongToOneAccount() throws Exception {
        ECKeyPair key = Keys.createEcKeyPair();
        String address = "0x" + Keys.getAddress(key);
        UUID first = newUser();
        links.link(first, EthTest.personalSign(key, links.createLinkMessage(first, "first", address)));

        UUID second = newUser();
        String message = links.createLinkMessage(second, "second", address);
        assertThatThrownBy(() -> links.link(second, EthTest.personalSign(key, message)))
                .isInstanceOfSatisfying(DomainException.class, e -> assertThat(e.code()).isEqualTo(ErrorCode.ADDRESS_TAKEN));
    }

    @Test
    void signatureFromAnotherKeyIsRejectedAndTheMessageIsSingleUse() throws Exception {
        UUID user = newUser();
        String address = "0x" + Keys.getAddress(Keys.createEcKeyPair());
        String message = links.createLinkMessage(user, "player", address);

        assertThatThrownBy(() -> links.link(user, EthTest.personalSign(Keys.createEcKeyPair(), message)))
                .isInstanceOfSatisfying(DomainException.class, e -> assertThat(e.code()).isEqualTo(ErrorCode.INVALID_SIGNATURE));
        assertThatThrownBy(() -> links.link(user, EthTest.personalSign(Keys.createEcKeyPair(), message)))
                .isInstanceOfSatisfying(DomainException.class, e -> assertThat(e.code()).isEqualTo(ErrorCode.LINK_MESSAGE_EXPIRED));
    }
}
