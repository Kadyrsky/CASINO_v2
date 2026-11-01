package win.naebka.kyc;

import java.time.Instant;
import java.time.LocalDate;
import java.util.List;

/**
 * Identity-verification step of KYC (Strategy). {@link RuleBasedKycProvider} runs local rule checks; a real vendor
 * (Sumsub, Onfido, Veriff, ...) would be another implementation behind the same interface.
 */
public interface KycProvider {

    enum Outcome { PASS, REVIEW, FAIL }

    /**
     * The person and document being verified. Date of birth and country come from the user's profile (the player
     * doesn't type them twice); {@code documentNumber} is normalized (upper case, no spaces or dashes).
     */
    record Applicant(String firstName, String lastName, LocalDate dateOfBirth, String documentType,
                     String documentCountry, String documentNumber, LocalDate documentExpiry) {}

    record ProfileChange(String field, String oldValue, String newValue, Instant changedAt) {}

    /** Risk signals from the account's history. */
    record History(List<ProfileChange> profileChanges, boolean documentUsedByAnotherUser) {}

    record Check(String check, Outcome outcome, String message) {}

    List<Check> verify(Applicant applicant, History history);

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
