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

    static KycService.Document document(String number) {
        return new KycService.Document("Jana", "Novak", "PASSPORT", number, LocalDate.now().plusYears(5));
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
    void cleanSubmissionIsVerifiedAutomaticallyFromProfileData() {
        UUID user = newUser(); // registered 1995-05-05 / CZ
        var view = kyc.submit(user, document(freshNumber()));
        assertThat(view.status()).isEqualTo("VERIFIED");
        assertThat(view.canWithdraw()).isTrue();
        assertThat(view.latest().decidedBy()).isEqualTo("AUTO");
        assertThat(view.latest().dateOfBirth()).isEqualTo(LocalDate.of(1995, 5, 5));
        assertThat(view.latest().documentCountry()).isEqualTo("CZ");
        assertThat(view.latest().documentNumberLast4()).hasSize(4);
        assertThat(code(() -> kyc.submit(user, document(freshNumber()))))
                .isEqualTo(ErrorCode.KYC_ALREADY_SUBMITTED.name());
    }

    @Test
    void badCheckDigitIsRejectedAndCanBeResubmitted() {
        UUID user = newUser();
        String good = freshNumber();
        String bad = good.substring(0, good.length() - 1) + ((good.charAt(good.length() - 1) - '0' + 1) % 10);
        var rejected = kyc.submit(user, document(bad));
        assertThat(rejected.status()).isEqualTo("REJECTED");
        assertThat(rejected.latest().reason()).contains("check digit");
        assertThat(kyc.submit(user, document(good)).status()).isEqualTo("VERIFIED");
    }

    @Test
    void recentProfileChangeGoesToTheAdminQueueAndIsAudited() {
        UUID user = newUser();
        auth.updateProfile(user, LocalDate.of(1995, 5, 6), "DE");
        var pending = kyc.submit(user, document(freshNumber()));
        assertThat(pending.status()).isEqualTo("PENDING");
        assertThat(pending.latest().reason()).contains("Date of birth changed").contains("CZ → DE");
        assertThat(pending.latest().documentCountry()).isEqualTo("DE");
        UUID submission = pending.latest().id();
        assertThat(kyc.reviewQueue()).extracting(KycRepository.Submission::id).contains(submission);

        // the reviewer is looking at these values: no changes until it's decided
        assertThat(code(() -> auth.updateProfile(user, LocalDate.of(1995, 5, 5), "DE")))
                .isEqualTo(ErrorCode.PROFILE_CHANGE_BLOCKED.name());

        UUID admin = admin();
        kyc.reject(submission, admin, "Date of birth does not match the document");
        assertThat(kyc.view(user).status()).isEqualTo("REJECTED");
        assertThat(code(() -> kyc.approve(submission, admin))).isEqualTo(ErrorCode.KYC_NOT_PENDING.name());
        long audited = jdbc.sql("SELECT count(*) FROM admin_audit_log WHERE action = 'KYC_REJECTED' AND target = ?")
                .param(submission.toString()).query(Long.class).single();
        assertThat(audited).isEqualTo(1);
    }

    @Test
    void changingProfileEndsAVerification() {
        UUID user = newUser();
        kyc.submit(user, document(freshNumber()));
        assertThat(kyc.view(user).status()).isEqualTo("VERIFIED");

        auth.updateProfile(user, LocalDate.of(1995, 5, 5), "CZ"); // no change: stays verified
        assertThat(kyc.view(user).status()).isEqualTo("VERIFIED");

        auth.updateProfile(user, LocalDate.of(1995, 5, 5), "SK");
        assertThat(kyc.view(user).status()).isEqualTo("NONE");
        assertThat(kyc.view(user).canWithdraw()).isFalse();
        assertThat(code(() -> auth.updateProfile(user, LocalDate.now().minusYears(17), "SK")))
                .isEqualTo(ErrorCode.UNDERAGE.name());
        assertThat(code(() -> auth.updateProfile(user, LocalDate.of(1995, 5, 5), "US")))
                .isEqualTo(ErrorCode.COUNTRY_NOT_LICENSED.name());
    }

    @Test
    void reusedDocumentIsFlaggedThenApproved() {
        String number = freshNumber();
        kyc.submit(newUser(), document(number));
        UUID second = newUser();
        var pending = kyc.submit(second, document(number));
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

        kyc.submit(user, document(freshNumber()));
        kyc.assertCanWithdraw(user);
        tx.inTransaction(() -> {
            kyc.assertCanDeposit(user, 1_000_000_00);
            return null;
        });
        assertThat(kyc.view(user).depositCapTokens()).isNull();
    }
}
