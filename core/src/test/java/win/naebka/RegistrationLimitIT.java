package win.naebka;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.TestPropertySource;
import win.naebka.common.Json;

/** Sign-ups are rate limited per IP, so bots can't mass-create accounts (each one gets the signup bonus). */
@TestPropertySource(properties = "naebka.auth.registrations-per-ip-per-hour=3")
class RegistrationLimitIT extends IntegrationTestBase {
    @Autowired
    TestRestTemplate http;

    /** The client IP as the reverse proxy reports it (Caddy sets X-Forwarded-For in production). */
    ResponseEntity<String> registerFrom(String ip) {
        String name = "rl" + UUID.randomUUID().toString().substring(0, 8);
        HttpHeaders h = new HttpHeaders();
        h.setContentType(MediaType.APPLICATION_JSON);
        h.set("X-Forwarded-For", ip);
        return http.postForEntity("/api/auth/register", new HttpEntity<>(Json.write(Map.of("username", name,
                "email", name + "@t.local", "password", "password123", "dateOfBirth", "1990-01-01", "country", "CZ")), h),
                String.class);
    }

    @Test
    void theFourthSignUpFromOneIpWithinAnHourIsRefused() {
        String ip = "203.0.113." + (int) (Math.random() * 250);
        for (int i = 0; i < 3; i++) {
            assertThat(registerFrom(ip).getStatusCode()).isEqualTo(HttpStatus.CREATED);
        }
        var fourth = registerFrom(ip);
        assertThat(fourth.getStatusCode()).isEqualTo(HttpStatus.TOO_MANY_REQUESTS);
        assertThat(Json.read(fourth.getBody()).path("code").asText()).isEqualTo("RATE_LIMITED");

        // Another visitor isn't affected
        assertThat(registerFrom("198.51.100." + (int) (Math.random() * 250)).getStatusCode()).isEqualTo(HttpStatus.CREATED);
    }
}
