package win.naebka.live;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;
import win.naebka.common.Money;
import win.naebka.config.NaebkaProperties;

/**
 * Who may watch a live match on the realtime map: admins and premium players always; other logged-in players once they
 * have at least {@code naebka.live-view.min-stake-tokens} staked on that match. Also tells the Steam bot which
 * matches viewers have open (sorted set {@code live:wanted}, see deadlock-bot/src/feeds.rs).
 */
@Component
public class LiveViewPolicy {
    /** A viewer's interest lasts this long unless refreshed (the relay refreshes it every 20 s). */
    static final int WANTED_FOR_SECONDS = 90;

    public enum Reason { ADMIN, PREMIUM, OPEN, STAKE, LOGIN_REQUIRED, STAKE_REQUIRED }

    public record Decision(boolean allowed, Reason reason, BigDecimal minStakeTokens, BigDecimal stakedTokens) {}

    private final JdbcClient jdbc;
    private final StringRedisTemplate redis;
    private final NaebkaProperties props;

    public LiveViewPolicy(JdbcClient jdbc, StringRedisTemplate redis, NaebkaProperties props) {
        this.jdbc = jdbc;
        this.redis = redis;
        this.props = props;
    }

    long minStakeMinor() {
        return props.liveView() == null ? 0 : props.liveView().minStakeTokens() * 100;
    }

    public Decision check(UUID userId, String externalMatchId) {
        BigDecimal min = Money.toTokens(minStakeMinor());
        if (userId == null) {
            return new Decision(false, Reason.LOGIN_REQUIRED, min, BigDecimal.ZERO);
        }
        record Who(String role, boolean premium) {}
        Optional<Who> who = jdbc.sql("SELECT role, premium FROM users WHERE id = ?").param(userId)
                .query((rs, i) -> new Who(rs.getString(1), rs.getBoolean(2))).optional();
        if (who.isEmpty()) {
            return new Decision(false, Reason.LOGIN_REQUIRED, min, BigDecimal.ZERO);
        }
        if ("ADMIN".equals(who.get().role())) {
            return new Decision(true, Reason.ADMIN, min, BigDecimal.ZERO);
        }
        if (who.get().premium()) {
            return new Decision(true, Reason.PREMIUM, min, BigDecimal.ZERO);
        }
        if (minStakeMinor() <= 0) {
            return new Decision(true, Reason.OPEN, min, BigDecimal.ZERO);
        }
        long staked = jdbc.sql("""
                SELECT coalesce(sum(b.stake), 0) FROM bets b
                JOIN wallets w ON w.id = b.wallet_id
                JOIN selections s ON s.id = b.selection_id
                JOIN markets mk ON mk.id = s.market_id
                JOIN matches m ON m.id = mk.match_id
                WHERE w.user_id = ? AND m.external_id = ? AND b.status <> 'VOID'""")
                .params(userId, externalMatchId).query(Long.class).single();
        boolean ok = staked >= minStakeMinor();
        return new Decision(ok, ok ? Reason.STAKE : Reason.STAKE_REQUIRED, min, Money.toTokens(staked));
    }

    /** Asks the Steam bot to follow this match's broadcast for the next {@link #WANTED_FOR_SECONDS}. */
    public void markWanted(String externalMatchId) {
        if (!externalMatchId.matches("\\d{1,20}")) {
            return;
        }
        try {
            redis.opsForZSet().add("live:wanted", externalMatchId, Instant.now().getEpochSecond() + WANTED_FOR_SECONDS);
        } catch (RuntimeException ignored) {
            // the map just stays empty until Redis is back
        }
    }
}
