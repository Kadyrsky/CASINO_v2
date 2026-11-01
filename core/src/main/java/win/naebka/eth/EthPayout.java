package win.naebka.eth;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.math.RoundingMode;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.function.Function;
import java.util.stream.Collectors;
import java.util.stream.Stream;
import org.web3j.abi.FunctionEncoder;
import org.web3j.abi.datatypes.Address;
import org.web3j.abi.datatypes.generated.Bytes32;
import org.web3j.abi.datatypes.generated.Uint256;
import org.web3j.crypto.Credentials;
import org.web3j.crypto.Hash;
import org.web3j.crypto.RawTransaction;
import org.web3j.crypto.TransactionEncoder;
import org.web3j.utils.Numeric;

/**
 * Pure helpers for paying withdrawals from NaebkaCashier: the calls the core makes, its limits and its error names.
 * Unit tested against values computed with ethers (contracts/test/NaebkaCashier.test.js checks the same selectors).
 */
public final class EthPayout {
    /** NaebkaCashier.MAX_PAYOUT: 0.05 ETH. */
    public static final BigInteger MAX_PAYOUT_WEI = new BigInteger("50000000000000000");
    /** The smallest withdrawal the site accepts: 0.0001 ETH, the same as the smallest deposit. */
    public static final BigInteger MIN_PAYOUT_WEI = new BigInteger("100000000000000");

    public static final String PAUSED_CALLDATA = selector("paused()");

    /** Custom error selector → name, to show why a payout would revert. */
    private static final Map<String, String> ERRORS = Stream.of("OnlyOwner", "OnlyOperator", "NotPendingOwner",
                    "AmountOutOfRange", "AlreadyPaid", "DailyLimitReached", "IsPaused", "ZeroAddress", "TransferFailed")
            .collect(Collectors.toUnmodifiableMap(n -> selector(n + "()"), Function.identity()));

    private EthPayout() {}

    static String selector(String signature) {
        return Hash.sha3String(signature).substring(0, 10);
    }

    /** The withdrawal's id as the contract's bytes32: the UUID's 16 bytes, left-padded (readable on Etherscan). */
    public static byte[] withdrawalId(UUID id) {
        return Numeric.toBytesPadded(new BigInteger(id.toString().replace("-", ""), 16), 32);
    }

    /** {@code payout(address to, uint256 amount, bytes32 withdrawalId)} call data. */
    public static String payoutCalldata(String to, BigInteger amountWei, UUID withdrawal) {
        return FunctionEncoder.encode(new org.web3j.abi.datatypes.Function("payout",
                List.of(new Address(to), new Uint256(amountWei), new Bytes32(withdrawalId(withdrawal))), List.of()));
    }

    /** {@code paid(bytes32)} call data: was this withdrawal already paid on chain? */
    public static String paidCalldata(UUID withdrawal) {
        return FunctionEncoder.encode(new org.web3j.abi.datatypes.Function("paid",
                List.of(new Bytes32(withdrawalId(withdrawal))), List.of()));
    }

    /** A bool returned by eth_call (32-byte word). */
    public static boolean decodeBool(String hex) {
        return hex != null && hex.length() > 2 && Numeric.toBigInt(hex).signum() != 0;
    }

    /** NTK minor units to wei at {@code tokensPerEth}, rounded down (the reverse of {@link Eth#weiToMinor}). */
    public static BigInteger minorToWei(long minor, BigDecimal tokensPerEth) {
        return BigDecimal.valueOf(minor).movePointRight(18 - 2).divide(tokensPerEth, 0, RoundingMode.DOWN)
                .toBigIntegerExact();
    }

    /** The contract error name in revert data, e.g. "DailyLimitReached", or null if it is not one of ours. */
    public static String errorName(String revertData) {
        if (revertData == null || revertData.length() < 10) {
            return null;
        }
        return ERRORS.get(revertData.substring(0, 10).toLowerCase(Locale.ROOT));
    }

    /** A signed EIP-1559 transaction and its hash (the hash is known before it is broadcast). */
    public record SignedTx(String rawHex, String hash) {}

    public static SignedTx sign(Credentials operator, long chainId, BigInteger nonce, String contract, String data,
                                BigInteger gasLimit, BigInteger maxPriorityFeePerGas, BigInteger maxFeePerGas) {
        RawTransaction tx = RawTransaction.createTransaction(chainId, nonce, gasLimit, contract, BigInteger.ZERO, data,
                maxPriorityFeePerGas, maxFeePerGas);
        String raw = Numeric.toHexString(TransactionEncoder.signMessage(tx, chainId, operator));
        return new SignedTx(raw, Hash.sha3(raw).toLowerCase(Locale.ROOT));
    }
}
