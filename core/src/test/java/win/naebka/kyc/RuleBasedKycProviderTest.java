package win.naebka.kyc;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Clock;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.List;
import org.junit.jupiter.api.Test;
import win.naebka.kyc.KycProvider.Applicant;
import win.naebka.kyc.KycProvider.Outcome;
import win.naebka.kyc.KycProvider.Profile;

class RuleBasedKycProviderTest {
    static final LocalDate TODAY = LocalDate.of(2026, 10, 28);
    static final LocalDate DOB = LocalDate.of(1995, 5, 5);
    // ICAO 9303 specimen passport number L898902C3, check digit 6
    static final String VALID_NUMBER = "L898902C36";

    final RuleBasedKycProvider provider = new RuleBasedKycProvider(18, List.of("CZ", "DE", "GB"),
            Clock.fixed(TODAY.atStartOfDay().toInstant(ZoneOffset.UTC), ZoneOffset.UTC));

    static Applicant applicant(LocalDate dob, String country, String number, LocalDate expiry) {
        return new Applicant("Jana", "Novak", dob, "PASSPORT", country, number, expiry);
    }

    static Applicant valid() {
        return applicant(DOB, "CZ", VALID_NUMBER, TODAY.plusYears(5));
    }

    static Profile profile() {
        return new Profile(DOB, "CZ", false);
    }

    Outcome outcomeOf(String check, List<KycProvider.Check> checks) {
        return checks.stream().filter(c -> c.check().equals(check)).findFirst().orElseThrow().outcome();
    }

    @Test
    void icaoCheckDigit() {
        assertThat(RuleBasedKycProvider.checkDigit("L898902C3")).isEqualTo(6);
        assertThat(RuleBasedKycProvider.hasValidCheckDigit(VALID_NUMBER)).isTrue();
        assertThat(RuleBasedKycProvider.hasValidCheckDigit("L898902C35")).isFalse();
        assertThat(RuleBasedKycProvider.hasValidCheckDigit("12345")).isFalse(); // too short
        assertThat(RuleBasedKycProvider.hasValidCheckDigit("L898902C3X")).isFalse(); // check digit must be a digit
    }

    @Test
    void cleanSubmissionPassesEveryCheck() {
        var checks = provider.verify(valid(), profile());
        assertThat(checks).allMatch(c -> c.outcome() == Outcome.PASS);
        assertThat(KycProvider.overall(checks)).isEqualTo(Outcome.PASS);
    }

    @Test
    void hardRuleViolationsFail() {
        var underage = provider.verify(applicant(TODAY.minusYears(17), "CZ", VALID_NUMBER, TODAY.plusYears(1)), profile());
        assertThat(outcomeOf("AGE", underage)).isEqualTo(Outcome.FAIL);

        var unlicensed = provider.verify(applicant(DOB, "US", VALID_NUMBER, TODAY.plusYears(1)), profile());
        assertThat(outcomeOf("COUNTRY_LICENSED", unlicensed)).isEqualTo(Outcome.FAIL);

        var expired = provider.verify(applicant(DOB, "CZ", VALID_NUMBER, TODAY), profile());
        assertThat(outcomeOf("DOCUMENT_NOT_EXPIRED", expired)).isEqualTo(Outcome.FAIL);

        var badDigit = provider.verify(applicant(DOB, "CZ", "L898902C35", TODAY.plusYears(1)), profile());
        assertThat(outcomeOf("DOCUMENT_CHECK_DIGIT", badDigit)).isEqualTo(Outcome.FAIL);
        assertThat(KycProvider.overall(badDigit)).isEqualTo(Outcome.FAIL);
    }

    @Test
    void profileMismatchesGoToReview() {
        var otherDob = provider.verify(valid(), new Profile(DOB.plusDays(1), "CZ", false));
        assertThat(outcomeOf("BIRTH_DATE_MATCHES_PROFILE", otherDob)).isEqualTo(Outcome.REVIEW);

        var otherCountry = provider.verify(applicant(DOB, "DE", VALID_NUMBER, TODAY.plusYears(5)), profile());
        assertThat(outcomeOf("COUNTRY_MATCHES_PROFILE", otherCountry)).isEqualTo(Outcome.REVIEW);

        var duplicate = provider.verify(valid(), new Profile(DOB, "CZ", true));
        assertThat(outcomeOf("DUPLICATE_DOCUMENT", duplicate)).isEqualTo(Outcome.REVIEW);
        assertThat(KycProvider.overall(duplicate)).isEqualTo(Outcome.REVIEW);
    }

    @Test
    void failBeatsReview() {
        var checks = provider.verify(applicant(DOB, "DE", "L898902C35", TODAY.plusYears(5)), profile());
        assertThat(KycProvider.overall(checks)).isEqualTo(Outcome.FAIL);
    }
}
