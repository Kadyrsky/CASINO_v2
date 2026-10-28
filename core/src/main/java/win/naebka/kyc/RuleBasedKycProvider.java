package win.naebka.kyc;

import java.time.Clock;
import java.time.LocalDate;
import java.time.Period;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Set;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;
import win.naebka.config.NaebkaProperties;

/**
 * Automatic KYC checks without an external vendor. Hard rule violations FAIL (auto-reject), mismatches against the
 * registration profile ask for REVIEW (admin queue), and a clean result is auto-approved.
 */
@Component
public class RuleBasedKycProvider implements KycProvider {
    private final int minAge;
    private final Set<String> licensedCountries;
    private final Clock clock;

    @Autowired
    public RuleBasedKycProvider(NaebkaProperties props) {
        this(props.registration().minAge(), props.registration().licensedCountries(), Clock.systemUTC());
    }

    RuleBasedKycProvider(int minAge, Collection<String> licensedCountries, Clock clock) {
        this.minAge = minAge;
        this.licensedCountries = Set.copyOf(licensedCountries);
        this.clock = clock;
    }

    @Override
    public List<Check> verify(Applicant a, Profile p) {
        LocalDate today = LocalDate.now(clock);
        List<Check> out = new ArrayList<>();

        int age = Period.between(a.dateOfBirth(), today).getYears();
        out.add(age >= minAge
                ? pass("AGE", "Applicant is " + age)
                : fail("AGE", "Applicant is under " + minAge));
        out.add(licensedCountries.contains(a.documentCountry())
                ? pass("COUNTRY_LICENSED", a.documentCountry() + " is a licensed country")
                : fail("COUNTRY_LICENSED", "Documents from " + a.documentCountry() + " are not accepted"));
        out.add(a.documentExpiry().isAfter(today)
                ? pass("DOCUMENT_NOT_EXPIRED", "Valid until " + a.documentExpiry())
                : fail("DOCUMENT_NOT_EXPIRED", "Document expired on " + a.documentExpiry()));
        out.add(hasValidCheckDigit(a.documentNumber())
                ? pass("DOCUMENT_CHECK_DIGIT", "Check digit matches")
                : fail("DOCUMENT_CHECK_DIGIT", "Document number check digit does not match"));

        out.add(a.dateOfBirth().equals(p.dateOfBirth())
                ? pass("BIRTH_DATE_MATCHES_PROFILE", "Matches registration")
                : review("BIRTH_DATE_MATCHES_PROFILE", "Date of birth differs from registration (" + p.dateOfBirth() + ")"));
        out.add(a.documentCountry().equals(p.country())
                ? pass("COUNTRY_MATCHES_PROFILE", "Matches registration")
                : review("COUNTRY_MATCHES_PROFILE", "Document country differs from registration (" + p.country() + ")"));
        out.add(!p.documentUsedByAnotherUser()
                ? pass("DUPLICATE_DOCUMENT", "Document not used by another account")
                : review("DUPLICATE_DOCUMENT", "Document is already linked to another account"));
        return out;
    }

    /**
     * The last character is the ICAO 9303 (machine-readable zone) check digit of the characters before it: digits
     * count as 0-9, letters A-Z as 10-35, weighted 7, 3, 1 repeating, sum mod 10.
     */
    static boolean hasValidCheckDigit(String number) {
        if (number == null || !number.matches("[A-Z0-9]{6,10}")) {
            return false;
        }
        int expected = number.charAt(number.length() - 1) - '0';
        return expected >= 0 && expected <= 9 && checkDigit(number.substring(0, number.length() - 1)) == expected;
    }

    static int checkDigit(String body) {
        int[] weights = {7, 3, 1};
        int sum = 0;
        for (int i = 0; i < body.length(); i++) {
            char c = body.charAt(i);
            int value = Character.isDigit(c) ? c - '0' : c - 'A' + 10;
            sum += value * weights[i % 3];
        }
        return sum % 10;
    }

    private static Check pass(String check, String message) {
        return new Check(check, Outcome.PASS, message);
    }

    private static Check review(String check, String message) {
        return new Check(check, Outcome.REVIEW, message);
    }

    private static Check fail(String check, String message) {
        return new Check(check, Outcome.FAIL, message);
    }
}
