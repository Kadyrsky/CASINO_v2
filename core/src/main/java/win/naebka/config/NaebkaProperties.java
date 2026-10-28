package win.naebka.config;

import java.math.BigDecimal;
import java.util.List;
import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "naebka")
public record NaebkaProperties(
        CurrencyMode currencyMode,
        String licenseSignoffFile,
        BigDecimal tokenFiatRate,
        String fiatCurrency,
        Jwt jwt,
        Admin admin,
        Registration registration,
        Kyc kyc,
        Auth auth,
        Wallet wallet,
        Betting betting,
        Settlement settlement,
        Poker poker,
        DeadlockApi deadlockApi) {

    public enum CurrencyMode { PLAY_MONEY, REAL_MONEY }

    public record Jwt(String secret, int ttlMinutes) {}

    public record Admin(String username, String password) {}

    public record Registration(int minAge, List<String> licensedCountries) {}

    /** Tiered limits for unverified users and the key for hashing document numbers (Risk #5). */
    public record Kyc(long unverifiedDepositCapTokens, String documentHashKey) {}

    public record Auth(int maxFailedLogins, int lockoutMinutes) {}

    public record Wallet(long maxDepositTokens, long signupBonusTokens) {}

    public record Betting(long minStakeTokens, long maxStakeTokens, long acceptanceDelayMs, int betsPerMinute,
                          int staleAfterSeconds, BigDecimal minOdds, BigDecimal maxOdds) {}

    public record Settlement(int pollSeconds, int reviewAfterMinutes) {}

    public record Poker(int turnTimeoutSeconds, int reconnectGraceSeconds, int rakePercent, int rakeCapBigBlinds,
                        int minBuyInBigBlinds, int maxBuyInBigBlinds, boolean blockSameIp) {}

    public record DeadlockApi(String baseUrl, int timeoutSeconds) {}
}
