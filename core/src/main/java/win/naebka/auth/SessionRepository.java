package win.naebka.auth;

import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

@Repository
public class SessionRepository {
    private final JdbcClient jdbc;

    public SessionRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    public record SessionRow(UUID id, String ipAddress, String userAgent, Instant createdAt, Instant expiresAt,
                             Instant revokedAt) {}

    public void insert(UUID id, UUID userId, String tokenHash, String ip, String userAgent, Instant expiresAt) {
        jdbc.sql("""
                INSERT INTO sessions (id, user_id, token_hash, ip_address, user_agent, expires_at)
                VALUES (?, ?, ?, ?, ?, ?)""")
                .params(id, userId, tokenHash, ip, userAgent, java.sql.Timestamp.from(expiresAt))
                .update();
    }

    public boolean isActive(UUID id) {
        return jdbc.sql("SELECT count(*) FROM sessions WHERE id = ? AND revoked_at IS NULL AND expires_at > now()")
                .param(id).query(Long.class).single() > 0;
    }

    public void extend(UUID id, String tokenHash, Instant expiresAt) {
        jdbc.sql("UPDATE sessions SET token_hash = ?, expires_at = ? WHERE id = ? AND revoked_at IS NULL")
                .params(tokenHash, java.sql.Timestamp.from(expiresAt), id).update();
    }

    public void revoke(UUID id, UUID userId) {
        jdbc.sql("UPDATE sessions SET revoked_at = now() WHERE id = ? AND user_id = ? AND revoked_at IS NULL")
                .params(id, userId).update();
    }

    public void revokeAll(UUID userId) {
        jdbc.sql("UPDATE sessions SET revoked_at = now() WHERE user_id = ? AND revoked_at IS NULL")
                .param(userId).update();
    }

    public List<SessionRow> listActive(UUID userId) {
        return jdbc.sql("""
                SELECT id, ip_address, user_agent, created_at, expires_at, revoked_at FROM sessions
                WHERE user_id = ? AND revoked_at IS NULL AND expires_at > now()
                ORDER BY created_at DESC""")
                .param(userId)
                .query((rs, i) -> new SessionRow(rs.getObject("id", UUID.class), rs.getString("ip_address"),
                        rs.getString("user_agent"), rs.getTimestamp("created_at").toInstant(),
                        rs.getTimestamp("expires_at").toInstant(), null))
                .list();
    }
}
