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
        DeadlockApi deadlockApi,
        Eth eth) {

    public enum CurrencyMode { PLAY_MONEY, REAL_MONEY }

    public record Jwt(String secret, int ttlMinutes) {}

    public record Admin(String username, String password) {}

    public record Registration(int minAge, List<String> licensedCountries) {}

    /** Tiered limits for unverified users, review of recent profile changes, document-number hash key (Risk #5). */
    public record Kyc(long unverifiedDepositCapTokens, int profileChangeReviewDays, String documentHashKey) {}

    public record Auth(int maxFailedLogins, int lockoutMinutes) {}

    public record Wallet(long maxDepositTokens, long signupBonusTokens) {}

    public record Betting(long minStakeTokens, long maxStakeTokens, long acceptanceDelayMs, int betsPerMinute,
                          int staleAfterSeconds, BigDecimal minOdds, BigDecimal maxOdds) {}

    public record Settlement(int pollSeconds, int reviewAfterMinutes) {}

    public record Poker(int turnTimeoutSeconds, int reconnectGraceSeconds, int rakePercent, int rakeCapBigBlinds,
                        int minBuyInBigBlinds, int maxBuyInBigBlinds, boolean blockSameIp) {}

    public record DeadlockApi(String baseUrl, int timeoutSeconds) {}

    /**
     * MetaMask + Sepolia deposits and withdrawals. Off until {@code contractAddress} is set (deploy
     * contracts/src/NaebkaCashier.sol first). {@code siweDomain}/{@code siweUri} must be the address players open in
     * the browser, or MetaMask warns that the sign-in message is for another site.
     *
     * <p>Withdrawals also need {@code operatorKey}: the private key of a Sepolia test account that the contract owner
     * made the operator ({@code setOperator}). It only pays gas; the ETH comes from the contract. {@code maxFeeGwei}
     * caps what one payout may pay per gas unit, {@code payoutGasLimit} the gas of one payout.
     */
    public record Eth(long chainId, String rpcUrl, String contractAddress, long deployBlock, int confirmations,
                      int pollSeconds, int maxBlockRange, BigDecimal tokensPerEth, String siweDomain, String siweUri,
                      int linkMessageTtlSeconds, String operatorKey, long maxFeeGwei, long payoutGasLimit) {
        public boolean configured() {
            return contractAddress != null && !contractAddress.isBlank();
        }

        public boolean withdrawalsEnabled() {
            return configured() && operatorKey != null && !operatorKey.isBlank();
        }
    }
}
