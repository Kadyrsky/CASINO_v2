package win.naebka.kyc;

import com.fasterxml.jackson.databind.JsonNode;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;
import win.naebka.common.Json;

@Repository
public class KycRepository {
    private final JdbcClient jdbc;

    public KycRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    /** Date of birth and country are the profile values at the time of submission. */
    public record Submission(UUID id, UUID userId, String username, String firstName, String lastName,
                             LocalDate dateOfBirth, String documentType, String documentCountry,
                             String documentNumberLast4, LocalDate documentExpiry, String status, String decidedBy,
                             JsonNode checks, String reason, Instant createdAt, Instant decidedAt) {}

    private static final String SELECT = """
            SELECT k.id, k.user_id, u.username, k.first_name, k.last_name, k.date_of_birth, k.document_type,
                   k.document_country, k.document_number_last4, k.document_expiry, k.status, k.decided_by, k.checks,
                   k.reason, k.created_at, k.decided_at
            FROM kyc_submissions k JOIN users u ON u.id = k.user_id""";

    private static Submission map(java.sql.ResultSet rs, int i) throws java.sql.SQLException {
        var decidedAt = rs.getTimestamp("decided_at");
        return new Submission(rs.getObject("id", UUID.class), rs.getObject("user_id", UUID.class),
                rs.getString("username"), rs.getString("first_name"), rs.getString("last_name"),
                rs.getDate("date_of_birth").toLocalDate(), rs.getString("document_type"),
                rs.getString("document_country"), rs.getString("document_number_last4"),
                rs.getDate("document_expiry").toLocalDate(), rs.getString("status"), rs.getString("decided_by"),
                Json.read(rs.getString("checks")), rs.getString("reason"), rs.getTimestamp("created_at").toInstant(),
                decidedAt == null ? null : decidedAt.toInstant());
    }

    /** Locks the user row, so a user's KYC submissions, decisions and capped deposits are serialized. */
    public String lockStatus(UUID userId) {
        return jdbc.sql("SELECT kyc_status FROM users WHERE id = ? FOR UPDATE").param(userId)
                .query(String.class).single();
    }

    public String status(UUID userId) {
        return jdbc.sql("SELECT kyc_status FROM users WHERE id = ?").param(userId).query(String.class).single();
    }

    public void setStatus(UUID userId, String status) {
        jdbc.sql("UPDATE users SET kyc_status = ?, updated_at = now() WHERE id = ?").params(status, userId).update();
    }

    public boolean documentUsedByAnotherUser(String documentHash, UUID userId) {
        return jdbc.sql("""
                SELECT count(*) FROM kyc_submissions
                WHERE document_number_hash = ? AND user_id <> ? AND status <> 'REJECTED'""")
                .params(documentHash, userId).query(Long.class).single() > 0;
    }

    public UUID insert(UUID userId, KycProvider.Applicant a, String documentHash, String status, String decidedBy,
                       String checksJson, String reason) {
        return jdbc.sql("""
                INSERT INTO kyc_submissions (user_id, first_name, last_name, date_of_birth, document_type,
                    document_country, document_number_hash, document_number_last4, document_expiry, status,
                    decided_by, checks, reason, decided_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, CASE WHEN ? = 'PENDING' THEN NULL ELSE now() END)
                RETURNING id""")
                .params(userId, a.firstName(), a.lastName(), a.dateOfBirth(), a.documentType(), a.documentCountry(),
                        documentHash, a.documentNumber().substring(Math.max(0, a.documentNumber().length() - 4)),
                        a.documentExpiry(), status, decidedBy, checksJson, reason, status)
                .query(UUID.class).single();
    }

    public Optional<Submission> latest(UUID userId) {
        return jdbc.sql(SELECT + " WHERE k.user_id = ? ORDER BY k.created_at DESC LIMIT 1").param(userId)
                .query(KycRepository::map).optional();
    }

    public Optional<Submission> find(UUID id) {
        return jdbc.sql(SELECT + " WHERE k.id = ?").param(id).query(KycRepository::map).optional();
    }

    public List<Submission> pending() {
        return jdbc.sql(SELECT + " WHERE k.status = 'PENDING' ORDER BY k.created_at").query(KycRepository::map).list();
    }

    /** Moves a PENDING submission to a final status; false if someone else already decided it. */
    public boolean decide(UUID id, String status, UUID reviewerId, String reason) {
        return jdbc.sql("""
                UPDATE kyc_submissions SET status = ?, decided_by = 'ADMIN', reviewer_id = ?, reason = ?,
                    decided_at = now()
                WHERE id = ? AND status = 'PENDING'""")
                .params(status, reviewerId, reason, id).update() == 1;
    }

    /** Player deposits ever made (the signup bonus is a DEPOSIT row too, but does not count). */
    public long lifetimeDeposits(UUID userId) {
        return jdbc.sql("""
                SELECT coalesce(sum(t.amount), 0) FROM transactions t JOIN wallets w ON w.id = t.wallet_id
                WHERE w.user_id = ? AND t.type = 'DEPOSIT' AND t.idempotency_key LIKE 'deposit:%'""")
                .param(userId).query(Long.class).single();
    }
}
