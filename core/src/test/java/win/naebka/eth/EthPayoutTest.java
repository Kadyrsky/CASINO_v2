package win.naebka.eth;

import static org.assertj.core.api.Assertions.assertThat;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.web3j.crypto.Credentials;
import org.web3j.crypto.Hash;
import org.web3j.crypto.SignedRawTransaction;
import org.web3j.crypto.TransactionDecoder;
import org.web3j.crypto.transaction.type.Transaction1559;
import org.web3j.utils.Numeric;

/** The payout calls the core builds by hand, checked against values computed with ethers v6. */
class EthPayoutTest {
    static final String OPERATOR_KEY = "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";
    /** ethers: new Wallet(OPERATOR_KEY).address */
    static final String OPERATOR_ADDRESS = "0x2c7536e3605d9c16a7a3d7b1898e529396a65c23";
    static final BigInteger GWEI = BigInteger.TEN.pow(9);

    @Test
    void selectorsMatchEthers() {
        // Also asserted in contracts/test/NaebkaCashier.test.js against the compiled contract.
        assertThat(EthPayout.selector("payout(address,uint256,bytes32)")).isEqualTo("0x9de34c05");
        assertThat(EthPayout.selector("paid(bytes32)")).isEqualTo("0xadd89bb2");
        assertThat(EthPayout.PAUSED_CALLDATA).isEqualTo("0x5c975abb");
    }

    @Test
    void payoutCalldataMatchesEthers() {
        UUID id = UUID.fromString("123e4567-e89b-12d3-a456-426614174000");
        String expected = "0x9de34c05"
                + "00000000000000000000000000000000000000000000000000000000000000aa"
                + "00000000000000000000000000000000000000000000000000038d7ea4c68000"
                + "00000000000000000000000000000000123e4567e89b12d3a456426614174000";
        assertThat(EthPayout.payoutCalldata("0x00000000000000000000000000000000000000aa",
                new BigInteger("1000000000000000"), id)).isEqualTo(expected);
    }

    @Test
    void withdrawalIdIsTheUuidLeftPadded() {
        UUID id = UUID.fromString("ffffffff-ffff-ffff-ffff-ffffffffffff"); // high bit set: still 32 bytes, no sign byte
        byte[] word = EthPayout.withdrawalId(id);
        assertThat(word).hasSize(32);
        assertThat(Numeric.toHexString(word)).isEqualTo("0x00000000000000000000000000000000ffffffffffffffffffffffffffffffff");
    }

    @Test
    void tokensAndWeiConvertBothWays() {
        BigDecimal rate = new BigDecimal("100000"); // 0.001 ETH = 100 NTK
        assertThat(EthPayout.minorToWei(10_000, rate)).isEqualTo(new BigInteger("1000000000000000"));
        assertThat(Eth.weiToMinor(EthPayout.minorToWei(12_345, rate), rate)).isEqualTo(12_345);
        assertThat(EthPayout.minorToWei(1, new BigDecimal("3"))).isEqualTo(new BigInteger("3333333333333333")); // rounds down
        assertThat(Eth.weiToMinor(EthPayout.MAX_PAYOUT_WEI, rate)).isEqualTo(500_000); // 5,000 NTK
        assertThat(Eth.weiToMinor(EthPayout.MIN_PAYOUT_WEI, rate)).isEqualTo(1_000); // 10 NTK
    }

    @Test
    void revertDataIsNamed() {
        assertThat(EthPayout.errorName(EthPayout.selector("IsPaused()"))).isEqualTo("IsPaused");
        assertThat(EthPayout.errorName(EthPayout.selector("AlreadyPaid()") + "00")).isEqualTo("AlreadyPaid");
        assertThat(EthPayout.errorName("0x12345678")).isNull();
        assertThat(EthPayout.errorName(null)).isNull();
    }

    @Test
    void boolResultsDecode() {
        assertThat(EthPayout.decodeBool("0x0000000000000000000000000000000000000000000000000000000000000001")).isTrue();
        assertThat(EthPayout.decodeBool("0x0000000000000000000000000000000000000000000000000000000000000000")).isFalse();
        assertThat(EthPayout.decodeBool("0x")).isFalse();
    }

    @Test
    void signedPayoutDecodesToTheOperatorAndTheCall() throws Exception {
        Credentials operator = Credentials.create(OPERATOR_KEY);
        assertThat(operator.getAddress()).isEqualTo(OPERATOR_ADDRESS);
        String data = EthPayout.payoutCalldata("0x00000000000000000000000000000000000000aa",
                new BigInteger("1000000000000000"), UUID.randomUUID());

        EthPayout.SignedTx tx = EthPayout.sign(operator, 11155111, BigInteger.valueOf(7), EthTest.CONTRACT, data,
                BigInteger.valueOf(100_000), GWEI, GWEI.multiply(BigInteger.valueOf(3)));

        assertThat(tx.hash()).isEqualTo(Hash.sha3(tx.rawHex()));
        SignedRawTransaction decoded = (SignedRawTransaction) TransactionDecoder.decode(tx.rawHex());
        assertThat(decoded.getFrom()).isEqualTo(OPERATOR_ADDRESS);
        assertThat(decoded.getNonce()).isEqualTo(BigInteger.valueOf(7));
        assertThat(decoded.getTo()).isEqualTo(EthTest.CONTRACT);
        assertThat(decoded.getValue()).isZero();
        assertThat(decoded.getData()).isEqualTo(Numeric.cleanHexPrefix(data));
        assertThat(decoded.getTransaction()).isInstanceOfSatisfying(Transaction1559.class, t -> {
            assertThat(t.getChainId()).isEqualTo(11155111L); // EIP-1559 keeps the chain id in the transaction
            assertThat(t.getMaxFeePerGas()).isEqualTo(GWEI.multiply(BigInteger.valueOf(3)));
            assertThat(t.getMaxPriorityFeePerGas()).isEqualTo(GWEI);
        });
    }
}
