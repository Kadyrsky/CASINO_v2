package win.naebka.auth;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.LocalDate;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import win.naebka.IntegrationTestBase;
import win.naebka.common.ErrorCode;
import win.naebka.common.Exceptions.DomainException;

/** Registration and login rules at their boundaries (test case designs TC-01 to TC-03). */
class AuthIT extends IntegrationTestBase {

    static String name() {
        return "a" + UUID.randomUUID().toString().substring(0, 8);
    }

    static String ip() {
        return "10.1." + (int) (Math.random() * 250) + "." + (int) (Math.random() * 250);
    }

    UUID register(String username, LocalDate dob, String country) {
        return auth.register(username, username + "@test.local", "password123", dob, country);
    }

    String code(Runnable r) {
        try {
            r.run();
            return "OK";
        } catch (DomainException e) {
            return e.code().name();
        }
    }

    /** TC-01, boundary value analysis: 18 today is the minimum; one day younger is rejected. */
    @Test
    void ageLimitIsExactlyEighteen() {
        LocalDate eighteenToday = LocalDate.now().minusYears(18);
        assertThat(code(() -> register(name(), eighteenToday, "CZ"))).isEqualTo("OK");
        assertThat(code(() -> register(name(), eighteenToday.plusDays(1), "CZ")))
                .isEqualTo(ErrorCode.UNDERAGE.name());
    }

    /** TC-02, equivalence partitioning: licensed vs not licensed countries (case-insensitive). */
    @Test
    void onlyLicensedCountriesCanRegister() {
        LocalDate adult = LocalDate.of(1995, 5, 5);
        assertThat(code(() -> register(name(), adult, "CZ"))).isEqualTo("OK");
        assertThat(code(() -> register(name(), adult, "gr"))).isEqualTo("OK");
        assertThat(code(() -> register(name(), adult, "US"))).isEqualTo(ErrorCode.COUNTRY_NOT_LICENSED.name());
        // AT was licensed in the first version of the list and was removed
        assertThat(code(() -> register(name(), adult, "AT"))).isEqualTo(ErrorCode.COUNTRY_NOT_LICENSED.name());
    }

    /** TC-03, boundary value analysis: the 5th wrong password locks the account, 4 do not. */
    @Test
    void fifthFailedLoginLocksTheAccount() {
        String user = name();
        String ip = ip();
        register(user, LocalDate.of(1995, 5, 5), "CZ");
        for (int i = 0; i < 4; i++) {
            assertThat(code(() -> auth.login(user, "wrong-password", ip, "test")))
                    .isEqualTo(ErrorCode.INVALID_CREDENTIALS.name());
        }
        // 4 failures: the right password still works and resets the counter
        assertThat(code(() -> auth.login(user, "password123", ip, "test"))).isEqualTo("OK");

        for (int i = 0; i < 5; i++) {
            assertThat(code(() -> auth.login(user, "wrong-password", ip, "test")))
                    .isEqualTo(ErrorCode.INVALID_CREDENTIALS.name());
        }
        // 5 failures in a row: locked, even with the right password
        assertThat(code(() -> auth.login(user, "password123", ip, "test")))
                .isEqualTo(ErrorCode.ACCOUNT_LOCKED.name());
    }
}
