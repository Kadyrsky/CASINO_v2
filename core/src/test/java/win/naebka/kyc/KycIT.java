package win.naebka.kyc;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.LocalDate;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.simple.JdbcClient;
import win.naebka.IntegrationTestBase;
import win.naebka.common.ErrorCode;
import win.naebka.common.Exceptions.DomainException;
import win.naebka.common.TxRetry;

/** The hybrid flow end to end: auto-approve, auto-reject, flag for review, admin decision, tiered limits. */
class KycIT extends IntegrationTestBase {
    @Autowired
    KycService kyc;
    @Autowired
    TxRetry tx;
    @Autowired
    JdbcClient jdbc;

    // newUser() registers with 1995-05-05 / CZ
    static KycProvider.Applicant applicant(LocalDate dob, String number) {
        return new KycProvider.Applicant("Jana", "Novak", dob, "PASSPORT", "CZ", number, LocalDate.now().plusYears(5));
    }

    /** A unique document number with a valid ICAO check digit. */
    static String freshNumber() {
        String body = "X" + String.format("%08d", Math.floorMod(UUID.randomUUID().getLeastSignificantBits(), 100_000_000L));
        return body + RuleBasedKycProvider.checkDigit(body);
    }

    UUID admin() {
        return jdbc.sql("SELECT id FROM users WHERE role = 'ADMIN' LIMIT 1").query(UUID.class).optional()
                .orElseGet(() -> {
                    UUID id = newUser();
                    jdbc.sql("UPDATE users SET role = 'ADMIN' WHERE id = ?").param(id).update();
                    return id;
                });
    }

    String code(Runnable r) {
        try {
            r.run();
            return null;
        } catch (DomainException e) {
            return e.code().name();
        }
    }

    @Test
    void cleanSubmissionIsVerifiedAutomatically() {
        UUID user = newUser();
        var view = kyc.submit(user, applicant(LocalDate.of(1995, 5, 5), freshNumber()));
        assertThat(view.status()).isEqualTo("VERIFIED");
        assertThat(view.canWithdraw()).isTrue();
        assertThat(view.latest().decidedBy()).isEqualTo("AUTO");
        assertThat(view.latest().documentNumberLast4()).hasSize(4);
        assertThat(code(() -> kyc.submit(user, applicant(LocalDate.of(1995, 5, 5), freshNumber()))))
                .isEqualTo(ErrorCode.KYC_ALREADY_SUBMITTED.name());
    }

    @Test
    void badCheckDigitIsRejectedAndCanBeResubmitted() {
        UUID user = newUser();
        String good = freshNumber();
        String bad = good.substring(0, good.length() - 1) + ((good.charAt(good.length() - 1) - '0' + 1) % 10);
        var rejected = kyc.submit(user, applicant(LocalDate.of(1995, 5, 5), bad));
        assertThat(rejected.status()).isEqualTo("REJECTED");
        assertThat(rejected.latest().reason()).contains("check digit");
        assertThat(kyc.submit(user, applicant(LocalDate.of(1995, 5, 5), good)).status()).isEqualTo("VERIFIED");
    }

    @Test
    void mismatchGoesToTheAdminQueueAndIsAudited() {
        UUID user = newUser();
        var pending = kyc.submit(user, applicant(LocalDate.of(1995, 5, 6), freshNumber()));
        assertThat(pending.status()).isEqualTo("PENDING");
        UUID submission = pending.latest().id();
        assertThat(kyc.reviewQueue()).extracting(KycRepository.Submission::id).contains(submission);

        UUID admin = admin();
        kyc.reject(submission, admin, "Date of birth does not match");
        assertThat(kyc.view(user).status()).isEqualTo("REJECTED");
        assertThat(code(() -> kyc.approve(submission, admin))).isEqualTo(ErrorCode.KYC_NOT_PENDING.name());
        long audited = jdbc.sql("SELECT count(*) FROM admin_audit_log WHERE action = 'KYC_REJECTED' AND target = ?")
                .param(submission.toString()).query(Long.class).single();
        assertThat(audited).isEqualTo(1);
    }

    @Test
    void reusedDocumentIsFlaggedThenApproved() {
        String number = freshNumber();
        kyc.submit(newUser(), applicant(LocalDate.of(1995, 5, 5), number));
        UUID second = newUser();
        var pending = kyc.submit(second, applicant(LocalDate.of(1995, 5, 5), number));
        assertThat(pending.status()).isEqualTo("PENDING");
        assertThat(pending.latest().reason()).contains("another account");
        kyc.approve(pending.latest().id(), admin());
        assertThat(kyc.view(second).status()).isEqualTo("VERIFIED");
    }

    @Test
    void unverifiedUsersCannotWithdrawAndDepositsAreCapped() {
        UUID user = newUser();
        assertThatThrownBy(() -> kyc.assertCanWithdraw(user)).isInstanceOf(DomainException.class)
                .extracting(e -> ((DomainException) e).code()).isEqualTo(ErrorCode.KYC_REQUIRED);
        // the cap is 2000 tokens; the signup bonus does not count
        tx.inTransaction(() -> {
            kyc.assertCanDeposit(user, 2000_00);
            return null;
        });
        assertThat(code(() -> tx.inTransaction(() -> {
            kyc.assertCanDeposit(user, 2000_01);
            return null;
        }))).isEqualTo(ErrorCode.KYC_REQUIRED.name());

        kyc.submit(user, applicant(LocalDate.of(1995, 5, 5), freshNumber()));
        kyc.assertCanWithdraw(user);
        tx.inTransaction(() -> {
            kyc.assertCanDeposit(user, 1_000_000_00);
            return null;
        });
        assertThat(kyc.view(user).depositCapTokens()).isNull();
    }
}
