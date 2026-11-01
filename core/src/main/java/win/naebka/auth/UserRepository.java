package win.naebka.auth;

import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

@Repository
public class UserRepository {
    private final JdbcClient jdbc;

    public UserRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    public record UserRow(UUID id, String username, String email, String passwordHash, String status, String role,
                          LocalDate dateOfBirth, String country, int failedLoginCount, Instant lockedUntil,
                          Instant createdAt) {}

    private static final String COLUMNS = """
            id, username, email, password_hash, status, role, date_of_birth, country, failed_login_count,
            locked_until, created_at""";

    private static UserRow map(java.sql.ResultSet rs, int i) throws java.sql.SQLException {
        var locked = rs.getTimestamp("locked_until");
        return new UserRow(rs.getObject("id", UUID.class), rs.getString("username"), rs.getString("email"),
                rs.getString("password_hash"), rs.getString("status"), rs.getString("role"),
                rs.getDate("date_of_birth").toLocalDate(), rs.getString("country"), rs.getInt("failed_login_count"),
                locked == null ? null : locked.toInstant(), rs.getTimestamp("created_at").toInstant());
    }

    public Optional<UserRow> findByUsername(String username) {
        return jdbc.sql("SELECT " + COLUMNS + " FROM users WHERE lower(username) = lower(?)")
                .param(username).query(UserRepository::map).optional();
    }

    public Optional<UserRow> findById(UUID id) {
        return jdbc.sql("SELECT " + COLUMNS + " FROM users WHERE id = ?").param(id).query(UserRepository::map).optional();
    }

    public boolean usernameExists(String username) {
        return jdbc.sql("SELECT count(*) FROM users WHERE lower(username) = lower(?)").param(username)
                .query(Long.class).single() > 0;
    }

    public boolean emailExists(String email) {
        return jdbc.sql("SELECT count(*) FROM users WHERE lower(email) = lower(?)").param(email)
                .query(Long.class).single() > 0;
    }

    public UUID insert(String username, String email, String passwordHash, String role, LocalDate dob, String country) {
        return jdbc.sql("""
                INSERT INTO users (username, email, password_hash, role, date_of_birth, country)
                VALUES (?, ?, ?, ?, ?, ?) RETURNING id""")
                .params(username, email, passwordHash, role, dob, country)
                .query(UUID.class).single();
    }

    public record ProfileChange(String field, String oldValue, String newValue, Instant changedAt) {}

    public void updateProfile(UUID id, LocalDate dob, String country) {
        jdbc.sql("UPDATE users SET date_of_birth = ?, country = ?, updated_at = now() WHERE id = ?")
                .params(dob, country, id).update();
    }

    public void recordProfileChange(UUID id, String field, String oldValue, String newValue) {
        jdbc.sql("INSERT INTO profile_changes (user_id, field, old_value, new_value) VALUES (?, ?, ?, ?)")
                .params(id, field, oldValue, newValue).update();
    }

    public List<ProfileChange> profileChangesSince(UUID id, Instant since) {
        return jdbc.sql("""
                SELECT field, old_value, new_value, changed_at FROM profile_changes
                WHERE user_id = ? AND changed_at >= ? ORDER BY changed_at DESC""")
                .params(id, java.sql.Timestamp.from(since))
                .query((rs, i) -> new ProfileChange(rs.getString(1), rs.getString(2), rs.getString(3),
                        rs.getTimestamp(4).toInstant()))
                .list();
    }

    public void recordFailedLogin(UUID id, int maxFailed, int lockoutMinutes) {
        jdbc.sql("""
                UPDATE users SET failed_login_count = failed_login_count + 1,
                    locked_until = CASE WHEN failed_login_count + 1 >= ?
                                        THEN now() + make_interval(mins => ?) ELSE locked_until END,
                    updated_at = now()
                WHERE id = ?""")
                .params(maxFailed, lockoutMinutes, id).update();
    }

    public void resetFailedLogins(UUID id) {
        jdbc.sql("UPDATE users SET failed_login_count = 0, locked_until = NULL, updated_at = now() WHERE id = ?")
                .param(id).update();
    }
}
