package win.naebka.eth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.web3j.crypto.ECKeyPair;
import org.web3j.crypto.Keys;
import org.web3j.crypto.Sign;
import org.web3j.utils.Numeric;
import win.naebka.common.ErrorCode;
import win.naebka.common.Exceptions.DomainException;
import win.naebka.common.Json;

class EthTest {
    // Fixed test key (never use outside tests).
    static final ECKeyPair KEY = ECKeyPair.create(new BigInteger("4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318", 16));
    static final String CONTRACT = "0x1111111111111111111111111111111111111111";

    static String personalSign(ECKeyPair key, String message) {
        Sign.SignatureData s = Sign.signPrefixedMessage(message.getBytes(StandardCharsets.UTF_8), key);
        byte[] out = new byte[65];
        System.arraycopy(s.getR(), 0, out, 0, 32);
        System.arraycopy(s.getS(), 0, out, 32, 32);
        out[64] = s.getV()[0];
        return Numeric.toHexString(out);
    }

    @Test
    void depositedTopicIsKeccakOfTheEventSignature() {
        // Cross-checked with an independent Keccak-256 implementation.
        assertThat(Eth.DEPOSITED_TOPIC).isEqualTo("0x2da466a7b24304f47e87fa2e1e5a81b9831ce54fec19055ce277ca2f39ba42c4");
    }

    @Test
    void personalSignRecoversTheSigner() {
        String message = "localhost:8080 wants you to sign in with your Ethereum account:\nhello";
        String expected = "0x" + Keys.getAddress(KEY);
        assertThat(Eth.recoverPersonalSign(message, personalSign(KEY, message))).isEqualTo(expected);
    }

    @Test
    void vAsZeroOrOneIsAccepted() {
        String message = "m";
        byte[] sig = Numeric.hexStringToByteArray(personalSign(KEY, message));
        sig[64] -= 27;
        assertThat(Eth.recoverPersonalSign(message, Numeric.toHexString(sig))).isEqualTo("0x" + Keys.getAddress(KEY));
    }

    @Test
    void aSignatureOverAnotherMessageRecoversSomeoneElse() {
        String sig = personalSign(KEY, "original");
        assertThat(Eth.recoverPersonalSign("tampered", sig)).isNotEqualTo("0x" + Keys.getAddress(KEY));
    }

    @Test
    void malformedSignaturesAreRejected() {
        for (String bad : new String[] {"", "0x1234", "not hex", null}) {
            assertThatThrownBy(() -> Eth.recoverPersonalSign("m", bad))
                    .isInstanceOfSatisfying(DomainException.class, e -> assertThat(e.code()).isEqualTo(ErrorCode.INVALID_SIGNATURE));
        }
    }

    @Test
    void addressesAreNormalisedAndValidated() {
        assertThat(Eth.normalize(" 0xAbCdEf0123456789abcdef0123456789ABCDEF01 ")).isEqualTo("0xabcdef0123456789abcdef0123456789abcdef01");
        assertThatThrownBy(() -> Eth.normalize("0x123")).isInstanceOf(DomainException.class);
        assertThatThrownBy(() -> Eth.normalize(null)).isInstanceOf(DomainException.class);
        assertThat(Eth.checksum("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed")).isEqualTo("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"); // EIP-55 vector
    }

    @Test
    void weiConvertsToTokensRoundingDown() {
        BigDecimal rate = new BigDecimal("100000"); // 0.001 ETH = 100 NTK
        assertThat(Eth.weiToMinor(new BigInteger("1000000000000000"), rate)).isEqualTo(10_000); // 100.00 NTK
        assertThat(Eth.weiToMinor(new BigInteger("50000000000000000"), rate)).isEqualTo(500_000); // 0.05 ETH = 5000 NTK
        assertThat(Eth.weiToMinor(new BigInteger("100000000009999"), rate)).isEqualTo(1_000); // 0.0001 ETH + dust
        assertThat(Eth.weiToMinor(BigInteger.ONE, rate)).isZero();
        assertThat(Eth.weiToEth(new BigInteger("1000000000000000"))).isEqualTo("0.001");
        assertThat(Eth.weiToEth(BigInteger.ZERO)).isEqualTo("0");
    }

    @Test
    void depositLogsAreParsedAndForeignOrRemovedLogsSkipped() {
        String player = "000000000000000000000000ab5801a7d398351b8be11c439e05c5b3259aec9b";
        String amount = "00000000000000000000000000000000000000000000000000038d7ea4c68000"; // 1e15 wei
        String good = """
                {"address":"%s","topics":["%s","0x%s"],"data":"0x%s","blockNumber":"0x10","transactionHash":"0xAA%s","logIndex":"0x2","removed":false}"""
                .formatted(CONTRACT, Eth.DEPOSITED_TOPIC, player, amount, "00".repeat(31));
        String removed = good.replace("\"removed\":false", "\"removed\":true");
        String foreign = good.replace(CONTRACT, "0x2222222222222222222222222222222222222222");
        var logs = EthRpcClient.parseDepositLogs(Json.read("[" + good + "," + removed + "," + foreign + "]"), CONTRACT);

        assertThat(logs).containsExactly(new EthRpcClient.ChainDeposit("0xaa" + "00".repeat(31), 2, 16,
                "0xab5801a7d398351b8be11c439e05c5b3259aec9b", new BigInteger("1000000000000000")));
    }

    @Test
    void ledgerKeyStartsWithDepositSoTheKycCapCountsIt() {
        assertThat(EthDepositService.ledgerKey(11155111, "0xabc", 3)).isEqualTo("deposit:eth:11155111:0xabc:3");
    }

    @Test
    void linkMessageFollowsSignInWithEthereum() {
        String msg = EthLinkService.buildMessage("localhost:8080", "http://localhost:8080",
                "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", "alice\"\nInjected", 11155111, "abc123DEF456ghjk",
                Instant.parse("2026-10-29T12:00:00Z"), Instant.parse("2026-10-29T12:05:00Z"));
        assertThat(msg.lines().toList()).startsWith(
                "localhost:8080 wants you to sign in with your Ethereum account:",
                "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
                "",
                "Link this address to the Naebka account \"aliceInjected\". Sepolia test ETH only: it has no value.",
                "",
                "URI: http://localhost:8080",
                "Version: 1",
                "Chain ID: 11155111",
                "Nonce: abc123DEF456ghjk",
                "Issued At: 2026-10-29T12:00:00Z",
                "Expiration Time: 2026-10-29T12:05:00Z");
        assertThat(List.of(msg.split("\n"))).hasSize(11);
    }
}
