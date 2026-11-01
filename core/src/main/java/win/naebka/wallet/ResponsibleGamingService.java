package win.naebka.wallet;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import win.naebka.common.ErrorCode;
import win.naebka.common.Exceptions.DomainException;
import win.naebka.common.Money;

/**
 * Responsible-gambling controls (Risk #4): deposit / wager / loss limits per rolling period and
 * self-exclusion. Lowering a limit applies immediately; raising one only after a 24-hour cooling-off.
 */
@Service
public class ResponsibleGamingService {
    static final Duration COOLING_OFF = Duration.ofHours(24);
    private static final List<String> WAGER_TYPES = List.of("BET_STAKE", "SLOT_BET", "POKER_BUY_IN");
    private static final List<String> RESULT_TYPES = List.of("BET_STAKE", "BET_PAYOUT", "BET_REFUND", "SLOT_BET",
            "SLOT_WIN", "JACKPOT_WIN", "POKER_BUY_IN", "POKER_CASH_OUT");

    private final JdbcClient jdbc;

    public ResponsibleGamingService(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    public record LimitView(String limitType, String period, long amount, Instant effectiveFrom, Long pendingAmount,
                            Instant pendingFrom, long usedInPeriod) {}

    public record SelfExclusionView(Instant startsAt, Instant endsAt) {}

    static Duration periodLength(String period) {
        return switch (period) {
            case "daily" -> Duration.ofDays(1);
            case "weekly" -> Duration.ofDays(7);
            case "monthly" -> Duration.ofDays(30);
            default -> throw new DomainException(ErrorCode.VALIDATION_FAILED, "Unknown period " + period);
        };
    }

    /** Throws SELF_EXCLUDED if the user has an active self-exclusion. */
    public void assertNotExcluded(UUID userId) {
        var active = activeExclusion(userId);
        if (active != null) {
            throw new DomainException(ErrorCode.SELF_EXCLUDED, active.endsAt() == null
                    ? "Your account is permanently self-excluded"
                    : "You are self-excluded until " + active.endsAt());
        }
    }

    /** Checks self-exclusion plus wager and loss limits for a new stake of {@code amountMinor}. */
    public void assertCanWager(UUID userId, long amountMinor) {
        assertNotExcluded(userId);
        for (String period : List.of("daily", "weekly", "monthly")) {
            Long wagerLimit = currentLimit(userId, "wager", period);
            if (wagerLimit != null && wagered(userId, period) + amountMinor > wagerLimit) {
                throw limitExceeded("wager", period, wagerLimit);
            }
            Long lossLimit = currentLimit(userId, "loss", period);
            if (lossLimit != null && netLoss(userId, period) + amountMinor > lossLimit) {
                throw limitExceeded("loss", period, lossLimit);
            }
        }
    }

    public void assertCanDeposit(UUID userId, long amountMinor) {
        assertNotExcluded(userId);
        for (String period : List.of("daily", "weekly", "monthly")) {
            Long limit = currentLimit(userId, "deposit", period);
            if (limit != null && deposited(userId, period) + amountMinor > limit) {
                throw limitExceeded("deposit", period, limit);
            }
        }
    }

    private static DomainException limitExceeded(String type, String period, long limit) {
        return new DomainException(ErrorCode.LIMIT_EXCEEDED,
                "This would exceed your " + period + " " + type + " limit of " + Money.toTokens(limit) + " tokens",
                Map.of("limitType", type, "period", period, "limit", Money.toTokens(limit)));
    }

    @Transactional
    public void setLimit(UUID userId, String limitType, String period, long amountMinor) {
        periodLength(period);
        if (!List.of("deposit", "loss", "wager").contains(limitType)) {
            throw new DomainException(ErrorCode.VALIDATION_FAILED, "Unknown limit type " + limitType);
        }
        Long current = currentLimit(userId, limitType, period);
        Instant effectiveFrom = current == null || amountMinor <= current ? Instant.now() : Instant.now().plus(COOLING_OFF);
        jdbc.sql("""
                INSERT INTO user_limits (user_id, currency_id, limit_type, period, amount, effective_from)
                SELECT ?, id, ?, ?, ?, ? FROM currencies WHERE code = 'NTK'""")
                .params(userId, limitType, period, amountMinor, java.sql.Timestamp.from(effectiveFrom)).update();
    }

    public List<LimitView> limits(UUID userId) {
        List<LimitView> out = new ArrayList<>();
        for (String type : List.of("deposit", "loss", "wager")) {
            for (String period : List.of("daily", "weekly", "monthly")) {
                Long current = currentLimit(userId, type, period);
                var pending = jdbc.sql("""
                        SELECT amount, effective_from FROM user_limits
                        WHERE user_id = ? AND limit_type = ? AND period = ? AND effective_from > now()
                        ORDER BY effective_from DESC LIMIT 1""")
                        .params(userId, type, period)
                        .query((rs, i) -> Map.entry(rs.getLong(1), rs.getTimestamp(2).toInstant())).optional();
                if (current == null && pending.isEmpty()) {
                    continue;
                }
                long used = switch (type) {
                    case "deposit" -> deposited(userId, period);
                    case "wager" -> wagered(userId, period);
                    default -> Math.max(0, netLoss(userId, period));
                };
                out.add(new LimitView(type, period, current == null ? 0 : current, null,
                        pending.map(Map.Entry::getKey).orElse(null), pending.map(Map.Entry::getValue).orElse(null), used));
            }
        }
        return out;
    }

    @Transactional
    public void selfExclude(UUID userId, Integer days) {
        Instant ends = days == null ? null : Instant.now().plus(Duration.ofDays(days));
        jdbc.sql("INSERT INTO self_exclusions (user_id, ends_at) VALUES (?, ?)")
                .params(userId, ends == null ? null : java.sql.Timestamp.from(ends)).update();
        // A self-excluded user is logged out everywhere.
        jdbc.sql("UPDATE sessions SET revoked_at = now() WHERE user_id = ? AND revoked_at IS NULL").param(userId).update();
    }

    public SelfExclusionView activeExclusion(UUID userId) {
        return jdbc.sql("""
                SELECT starts_at, ends_at FROM self_exclusions
                WHERE user_id = ? AND starts_at <= now() AND (ends_at IS NULL OR ends_at > now())
                ORDER BY ends_at DESC NULLS FIRST LIMIT 1""")
                .param(userId)
                .query((rs, i) -> new SelfExclusionView(rs.getTimestamp(1).toInstant(),
                        rs.getTimestamp(2) == null ? null : rs.getTimestamp(2).toInstant()))
                .optional().orElse(null);
    }

    private Long currentLimit(UUID userId, String type, String period) {
        return jdbc.sql("""
                SELECT amount FROM user_limits
                WHERE user_id = ? AND limit_type = ? AND period = ? AND effective_from <= now()
                ORDER BY effective_from DESC, created_at DESC LIMIT 1""")
                .params(userId, type, period).query(Long.class).optional().orElse(null);
    }

    private long sumSince(UUID userId, List<String> types, String period) {
        return jdbc.sql("""
                SELECT coalesce(sum(t.amount), 0) FROM transactions t JOIN wallets w ON w.id = t.wallet_id
                WHERE w.user_id = :user AND t.type IN (:types) AND t.created_at > now() - :secs * interval '1 second'""")
                .param("user", userId).param("types", types).param("secs", periodLength(period).toSeconds())
                .query(Long.class).single();
    }

    long deposited(UUID userId, String period) {
        return sumSince(userId, List.of("DEPOSIT"), period);
    }

    long wagered(UUID userId, String period) {
        return -sumSince(userId, WAGER_TYPES, period);
    }

    /** Stakes minus returns in the period; positive = the player is down. */
    long netLoss(UUID userId, String period) {
        return -sumSince(userId, RESULT_TYPES, period);
    }
}
