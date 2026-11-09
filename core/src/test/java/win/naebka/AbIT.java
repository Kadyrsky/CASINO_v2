package win.naebka;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import win.naebka.common.Json;

/** A/B tracking and feedback: anonymous visitors can report, admins see the sums, players don't. */
class AbIT extends IntegrationTestBase {
    @Autowired
    TestRestTemplate http;

    ResponseEntity<String> call(HttpMethod method, String path, Object body, String bearer) {
        HttpHeaders h = new HttpHeaders();
        h.setContentType(MediaType.APPLICATION_JSON);
        if (bearer != null) {
            h.setBearerAuth(bearer);
        }
        return http.exchange(path, method, new HttpEntity<>(body == null ? null : Json.write(body), h), String.class);
    }

    String token(String username, String password) {
        var res = http.postForEntity("/api/auth/login", Map.of("username", username, "password", password), String.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        return Json.read(res.getBody()).path("token").asText();
    }

    JsonNode variant(JsonNode results, String experiment, String variant) {
        for (JsonNode e : results) {
            if (e.path("experiment").asText().equals(experiment)) {
                for (JsonNode v : e.path("variants")) {
                    if (v.path("variant").asText().equals(variant)) {
                        return v;
                    }
                }
            }
        }
        throw new AssertionError(experiment + "/" + variant + " missing from " + results);
    }

    @Test
    void anonymousVisitorsAreCountedByTheirAssignedVariant() {
        String exp = "test_" + UUID.randomUUID().toString().substring(0, 8);
        UUID kept = UUID.randomUUID();
        UUID switcher = UUID.randomUUID();

        for (UUID v : List.of(kept, switcher)) {
            var res = call(HttpMethod.POST, "/api/ab/assignments", Map.of("visitorId", v,
                    "assignments", List.of(Map.of("experiment", exp, "assigned", "b", "current", "b"))), null);
            assertThat(res.getStatusCode()).isEqualTo(HttpStatus.NO_CONTENT);
        }
        assertThat(call(HttpMethod.POST, "/api/ab/switches", Map.of("visitorId", switcher, "experiment", exp,
                "assigned", "b", "from", "b", "to", "a"), null).getStatusCode()).isEqualTo(HttpStatus.NO_CONTENT);
        call(HttpMethod.POST, "/api/ab/goals", Map.of("visitorId", kept, "goal", "registered"), null);
        call(HttpMethod.POST, "/api/ab/goals", Map.of("visitorId", kept, "goal", "registered"), null); // counted once
        assertThat(call(HttpMethod.POST, "/api/feedback", Map.of("visitorId", switcher, "rating", 2, "category", "ui",
                "message", "Too bright", "path", "/slots", "variants", Map.of(exp, "a")), null).getStatusCode())
                .isEqualTo(HttpStatus.CREATED);

        String admin = token("admin", "admin12345");
        JsonNode results = Json.read(call(HttpMethod.GET, "/api/admin/ab/results", null, admin).getBody());
        JsonNode b = variant(results, exp, "b");
        assertThat(b.path("visitors").asLong()).isEqualTo(2);
        assertThat(b.path("switchedAway").asLong()).isEqualTo(1);
        assertThat(b.path("onItNow").asLong()).isEqualTo(1);
        assertThat(b.path("goals").path("registered").asLong()).isEqualTo(1);
        JsonNode a = variant(results, exp, "a");
        assertThat(a.path("onItNow").asLong()).isEqualTo(1);
        assertThat(a.path("avgRating").asDouble()).isEqualTo(2.0);

        JsonNode feedback = Json.read(call(HttpMethod.GET, "/api/admin/feedback?experiment=" + exp + "&variant=a", null, admin).getBody());
        assertThat(feedback).hasSize(1);
        assertThat(feedback.get(0).path("message").asText()).isEqualTo("Too bright");
    }

    @Test
    void badInputIsRejectedAndResultsAreAdminOnly() {
        var badRating = call(HttpMethod.POST, "/api/feedback", Map.of("visitorId", UUID.randomUUID(), "rating", 9,
                "category", "ui", "path", "/"), null);
        assertThat(badRating.getStatusCode().is4xxClientError()).isTrue();
        var badName = call(HttpMethod.POST, "/api/ab/goals", Map.of("visitorId", UUID.randomUUID(), "goal", "<script>"), null);
        assertThat(badName.getStatusCode().is4xxClientError()).isTrue();

        String name = "ab" + UUID.randomUUID().toString().substring(0, 8);
        http.postForEntity("/api/auth/register", Map.of("username", name, "email", name + "@t.local",
                "password", "password123", "dateOfBirth", "1990-01-01", "country", "CZ"), String.class);
        String player = token(name, "password123");
        assertThat(call(HttpMethod.GET, "/api/admin/ab/results", null, player).getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(call(HttpMethod.GET, "/api/admin/feedback", null, null).getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
    }

    @Test
    void choicesFollowAPlayerToAnotherDevice() {
        String name = "ab" + UUID.randomUUID().toString().substring(0, 8);
        http.postForEntity("/api/auth/register", Map.of("username", name, "email", name + "@t.local",
                "password", "password123", "dateOfBirth", "1990-01-01", "country", "CZ"), String.class);
        String player = token(name, "password123");
        // Nobody has been seen on this account yet (null fields are left out of the JSON).
        assertThat(Json.read(call(HttpMethod.GET, "/api/ab/mine", null, player).getBody()).path("visitorId").asText(null)).isNull();

        UUID laptop = UUID.randomUUID();
        call(HttpMethod.POST, "/api/ab/assignments", Map.of("visitorId", laptop,
                "assignments", List.of(Map.of("experiment", "theme", "assigned", "hidden_king", "current", "hidden_king"))), player);
        call(HttpMethod.POST, "/api/ab/switches", Map.of("visitorId", laptop, "experiment", "theme",
                "assigned", "hidden_king", "from", "hidden_king", "to", "archmother"), player);

        JsonNode mine = Json.read(call(HttpMethod.GET, "/api/ab/mine", null, player).getBody());
        assertThat(mine.path("visitorId").asText()).isEqualTo(laptop.toString());
        assertThat(mine.path("choices").path("theme").asText()).isEqualTo("archmother");
    }
}
