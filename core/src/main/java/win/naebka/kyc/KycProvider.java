package win.naebka.kyc;

import java.time.LocalDate;
import java.util.List;

/**
 * Identity-verification step of KYC (Strategy). {@link RuleBasedKycProvider} runs local rule checks; a real vendor
 * (Sumsub, Onfido, Veriff, ...) would be another implementation behind the same interface.
 */
public interface KycProvider {

    enum Outcome { PASS, REVIEW, FAIL }

    /** What the user submitted. {@code documentNumber} is normalized (upper case, no spaces or dashes). */
    record Applicant(String firstName, String lastName, LocalDate dateOfBirth, String documentType,
                     String documentCountry, String documentNumber, LocalDate documentExpiry) {}

    /** What we already know about the user, to cross-check the submission against. */
    record Profile(LocalDate dateOfBirth, String country, boolean documentUsedByAnotherUser) {}

    record Check(String check, Outcome outcome, String message) {}

    List<Check> verify(Applicant applicant, Profile profile);

    /** FAIL beats REVIEW beats PASS: one hard failure rejects, one doubt sends it to a human. */
    static Outcome overall(List<Check> checks) {
        if (checks.stream().anyMatch(c -> c.outcome() == Outcome.FAIL)) {
            return Outcome.FAIL;
        }
        if (checks.stream().anyMatch(c -> c.outcome() == Outcome.REVIEW)) {
            return Outcome.REVIEW;
        }
        return Outcome.PASS;
    }
}
