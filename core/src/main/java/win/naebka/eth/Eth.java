package win.naebka.eth;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.math.RoundingMode;
import java.nio.charset.StandardCharsets;
import java.security.SignatureException;
import java.util.Arrays;
import java.util.Locale;
import java.util.regex.Pattern;
import org.web3j.crypto.Hash;
import org.web3j.crypto.Keys;
import org.web3j.crypto.Sign;
import org.web3j.utils.Numeric;
import win.naebka.common.ErrorCode;
import win.naebka.common.Exceptions.DomainException;

/** Small, pure Ethereum helpers: address checks, personal_sign recovery, unit conversion. Unit tested. */
public final class Eth {
    private static final Pattern ADDRESS = Pattern.compile("^0x[0-9a-fA-F]{40}$");
    private static final Pattern HASH = Pattern.compile("^0x[0-9a-fA-F]{64}$");

    /** topic0 of {@code event Deposited(address indexed player, uint256 amount)} in NaebkaCashier.sol. */
    public static final String DEPOSITED_TOPIC = Hash.sha3String("Deposited(address,uint256)");

    private Eth() {}

    public static boolean isAddress(String s) {
        return s != null && ADDRESS.matcher(s).matches();
    }

    public static boolean isHash(String s) {
        return s != null && HASH.matcher(s).matches();
    }

    /** Lower-case form used in the database. Throws VALIDATION_FAILED for anything that is not 0x + 40 hex digits. */
    public static String normalize(String address) {
        String a = address == null ? null : address.trim();
        if (!isAddress(a)) {
            throw new DomainException(ErrorCode.VALIDATION_FAILED,
                    "Enter a valid Ethereum address (0x followed by 40 hexadecimal digits)");
        }
        return a.toLowerCase(Locale.ROOT);
    }

    /** EIP-55 mixed-case form, as MetaMask shows it. */
    public static String checksum(String address) {
        return Keys.toChecksumAddress(normalize(address));
    }

    /** An indexed address topic (32 bytes, left-padded) back to a lower-case address. */
    public static String addressFromTopic(String topic) {
        if (!isHash(topic)) {
            throw new IllegalArgumentException("Not a 32-byte topic: " + topic);
        }
        return "0x" + topic.substring(26).toLowerCase(Locale.ROOT);
    }

    /**
     * The address that produced an EIP-191 {@code personal_sign} signature (65 bytes r‖s‖v, hex) over
     * {@code message}. Throws INVALID_SIGNATURE if the signature is malformed.
     */
    public static String recoverPersonalSign(String message, String signatureHex) {
        byte[] sig;
        try {
            sig = Numeric.hexStringToByteArray(signatureHex == null ? "" : signatureHex.trim());
        } catch (RuntimeException e) {
            throw invalidSignature();
        }
        if (sig.length != 65) {
            throw invalidSignature();
        }
        byte v = sig[64];
        if (v < 27) {
            v += 27; // some wallets return v as 0/1
        }
        var data = new Sign.SignatureData(v, Arrays.copyOfRange(sig, 0, 32), Arrays.copyOfRange(sig, 32, 64));
        try {
            BigInteger publicKey = Sign.signedPrefixedMessageToKey(message.getBytes(StandardCharsets.UTF_8), data);
            return "0x" + Keys.getAddress(publicKey).toLowerCase(Locale.ROOT);
        } catch (SignatureException | RuntimeException e) {
            throw invalidSignature();
        }
    }

    /** Wei to NTK minor units at {@code tokensPerEth}, rounded down (in the house's favour by < 1 minor unit). */
    public static long weiToMinor(BigInteger wei, BigDecimal tokensPerEth) {
        return new BigDecimal(wei).multiply(tokensPerEth).movePointLeft(18 - 2)
                .setScale(0, RoundingMode.DOWN).longValueExact();
    }

    /** Wei as a plain decimal ETH string, e.g. 1000000000000000 → "0.001". */
    public static String weiToEth(BigInteger wei) {
        BigDecimal eth = new BigDecimal(wei).movePointLeft(18).stripTrailingZeros();
        return eth.signum() == 0 ? "0" : eth.toPlainString();
    }

    private static DomainException invalidSignature() {
        return new DomainException(ErrorCode.INVALID_SIGNATURE, "The signature could not be verified. Sign again in MetaMask.");
    }
}
