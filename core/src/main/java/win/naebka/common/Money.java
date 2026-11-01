package win.naebka.common;

import java.math.BigDecimal;
import java.math.RoundingMode;

/**
 * Token amounts: the API speaks decimal tokens (e.g. 12.50), the database stores minor units
 * (1250) as defined by currencies.decimals = 2 for NTK.
 */
public final class Money {
    public static final int DECIMALS = 2;
    private static final BigDecimal SCALE = BigDecimal.TEN.pow(DECIMALS);

    private Money() {}

    public static long toMinor(BigDecimal tokens) {
        if (tokens == null || tokens.stripTrailingZeros().scale() > DECIMALS) {
            throw new Exceptions.DomainException(ErrorCode.INVALID_AMOUNT, "Amount must have at most 2 decimals");
        }
        return tokens.multiply(SCALE).longValueExact();
    }

    public static BigDecimal toTokens(long minor) {
        return BigDecimal.valueOf(minor, DECIMALS);
    }

    /** Payout for a winning fixed-odds bet. Rounding policy: always round down (in the house's favour by < 1 minor unit). */
    public static long payout(long stakeMinor, BigDecimal odds) {
        return BigDecimal.valueOf(stakeMinor).multiply(odds).setScale(0, RoundingMode.DOWN).longValueExact();
    }
}
