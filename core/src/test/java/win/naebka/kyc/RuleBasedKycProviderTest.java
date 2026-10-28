package win.naebka.kyc;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.time.temporal.ChronoUnit;
import java.util.List;
import org.junit.jupiter.api.Test;
import win.naebka.kyc.KycProvider.Applicant;
import win.naebka.kyc.KycProvider.History;
import win.naebka.kyc.KycProvider.Outcome;
import win.naebka.kyc.KycProvider.ProfileChange;

class RuleBasedKycProviderTest {
    static final LocalDate TODAY = LocalDate.of(2026, 10, 28);
    static final Instant NOW = TODAY.atStartOfDay().toInstant(ZoneOffset.UTC);
    static final LocalDate DOB = LocalDate.of(1995, 5, 5);
    // ICAO 9303 specimen passport number L898902C3, check digit 6
    static final String VALID_NUMBER = "L898902C36";
    static final History CLEAN = new History(List.of(), false);

    final RuleBasedKycProvider provider = new RuleBasedKycProvider(18, List.of("CZ", "DE", "GB"), 30,
            Clock.fixed(NOW, ZoneOffset.UTC));

    static Applicant applicant(LocalDate dob, String country, String number, LocalDate expiry) {
        return new Applicant("Jana", "Novak", dob, "PASSPORT", country, number, expiry);
    }

    static Applicant valid() {
        return applicant(DOB, "CZ", VALID_NUMBER, TODAY.plusYears(5));
    }

    static ProfileChange dobChange(int daysAgo) {
        return new ProfileChange("date_of_birth", "1995-05-06", DOB.toString(), NOW.minus(daysAgo, ChronoUnit.DAYS));
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
        var checks = provider.verify(valid(), CLEAN);
        assertThat(checks).allMatch(c -> c.outcome() == Outcome.PASS);
        assertThat(KycProvider.overall(checks)).isEqualTo(Outcome.PASS);
    }

    @Test
    void hardRuleViolationsFail() {
        var underage = provider.verify(applicant(TODAY.minusYears(17), "CZ", VALID_NUMBER, TODAY.plusYears(1)), CLEAN);
        assertThat(outcomeOf("AGE", underage)).isEqualTo(Outcome.FAIL);

        var unlicensed = provider.verify(applicant(DOB, "US", VALID_NUMBER, TODAY.plusYears(1)), CLEAN);
        assertThat(outcomeOf("COUNTRY_LICENSED", unlicensed)).isEqualTo(Outcome.FAIL);

        var expired = provider.verify(applicant(DOB, "CZ", VALID_NUMBER, TODAY), CLEAN);
        assertThat(outcomeOf("DOCUMENT_NOT_EXPIRED", expired)).isEqualTo(Outcome.FAIL);

        var badDigit = provider.verify(applicant(DOB, "CZ", "L898902C35", TODAY.plusYears(1)), CLEAN);
        assertThat(outcomeOf("DOCUMENT_CHECK_DIGIT", badDigit)).isEqualTo(Outcome.FAIL);
        assertThat(KycProvider.overall(badDigit)).isEqualTo(Outcome.FAIL);
    }

    @Test
    void recentProfileChangeGoesToReview() {
        var recent = provider.verify(valid(), new History(List.of(dobChange(2)), false));
        assertThat(outcomeOf("RECENT_PROFILE_CHANGE", recent)).isEqualTo(Outcome.REVIEW);
        assertThat(KycProvider.overall(recent)).isEqualTo(Outcome.REVIEW);
        assertThat(recent).anySatisfy(c -> assertThat(c.message()).contains("1995-05-06 → 1995-05-05"));

        var old = provider.verify(valid(), new History(List.of(dobChange(31)), false));
        assertThat(outcomeOf("RECENT_PROFILE_CHANGE", old)).isEqualTo(Outcome.PASS);
    }

    @Test
    void reusedDocumentGoesToReview() {
        var duplicate = provider.verify(valid(), new History(List.of(), true));
        assertThat(outcomeOf("DUPLICATE_DOCUMENT", duplicate)).isEqualTo(Outcome.REVIEW);
        assertThat(KycProvider.overall(duplicate)).isEqualTo(Outcome.REVIEW);
    }

    @Test
    void failBeatsReview() {
        var checks = provider.verify(applicant(DOB, "CZ", "L898902C35", TODAY.plusYears(5)),
                new History(List.of(dobChange(1)), true));
        assertThat(KycProvider.overall(checks)).isEqualTo(Outcome.FAIL);
    }
}
