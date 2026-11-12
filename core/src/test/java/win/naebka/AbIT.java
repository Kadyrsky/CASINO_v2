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
        assertThat(call(HttpMethod.GET, "/api/admin/ab/votes", null, player).getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(call(HttpMethod.GET, "/api/admin/ab/visitors", null, player).getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(call(HttpMethod.GET, "/api/admin/feedback", null, null).getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
    }

    @Test
    void tasteTestAnswersAreStoredOncePerPairAndShownToAdmins() {
        String exp = "taste_" + UUID.randomUUID().toString().substring(0, 8);
        UUID visitor = UUID.randomUUID();
        // Shown as (zeta, alpha): stored as the pair (alpha, zeta) with zeta on the left.
        assertThat(call(HttpMethod.POST, "/api/ab/votes", Map.of("visitorId", visitor, "experiment", exp, "left", "zeta",
                "right", "alpha", "winner", "zeta", "previewedBoth", true, "decisionMs", 4200), null).getStatusCode())
                .isEqualTo(HttpStatus.NO_CONTENT);
        // Answering the same pair again (sides swapped) replaces the answer instead of counting twice.
        call(HttpMethod.POST, "/api/ab/votes", Map.of("visitorId", visitor, "experiment", exp, "left", "alpha",
                "right", "zeta", "winner", "alpha", "previewedBoth", true, "decisionMs", 3100), null);
        // "No preference" has no winner.
        Map<String, Object> tie = new java.util.HashMap<>(Map.of("visitorId", UUID.randomUUID(), "experiment", exp,
                "left", "alpha", "right", "beta", "previewedBoth", false));
        assertThat(call(HttpMethod.POST, "/api/ab/votes", tie, null).getStatusCode()).isEqualTo(HttpStatus.NO_CONTENT);
        // The winner has to be one of the two.
        assertThat(call(HttpMethod.POST, "/api/ab/votes", Map.of("visitorId", visitor, "experiment", exp, "left", "alpha",
                "right", "beta", "winner", "gamma", "previewedBoth", true), null).getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(call(HttpMethod.POST, "/api/ab/votes", Map.of("visitorId", visitor, "experiment", exp, "left", "alpha",
                "right", "alpha", "winner", "alpha", "previewedBoth", true), null).getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);

        String admin = token("admin", "admin12345");
        List<JsonNode> mine = new java.util.ArrayList<>();
        Json.read(call(HttpMethod.GET, "/api/admin/ab/votes", null, admin).getBody()).forEach(v -> {
            if (v.path("experiment").asText().equals(exp)) {
                mine.add(v);
            }
        });
        assertThat(mine).hasSize(2);
        JsonNode answer = mine.stream().filter(v -> v.path("variantB").asText().equals("zeta")).findFirst().orElseThrow();
        assertThat(answer.path("variantA").asText()).isEqualTo("alpha");
        assertThat(answer.path("left").asText()).isEqualTo("alpha");
        assertThat(answer.path("winner").asText()).isEqualTo("alpha");
        assertThat(answer.path("decisionMs").asInt()).isEqualTo(3100);
        JsonNode noPreference = mine.stream().filter(v -> v.path("variantB").asText().equals("beta")).findFirst().orElseThrow();
        assertThat(noPreference.path("winner").isMissingNode() || noPreference.path("winner").isNull()).isTrue();
        assertThat(noPreference.path("previewedBoth").asBoolean()).isFalse();
    }

    @Test
    void tasteTestPicksAreNotCountedAsSwitchingAway() {
        String exp = "src_" + UUID.randomUUID().toString().substring(0, 8);
        UUID byHand = UUID.randomUUID();
        UUID inTest = UUID.randomUUID();
        for (UUID v : List.of(byHand, inTest)) {
            call(HttpMethod.POST, "/api/ab/assignments", Map.of("visitorId", v,
                    "assignments", List.of(Map.of("experiment", exp, "assigned", "a", "current", "a"))), null);
        }
        call(HttpMethod.POST, "/api/ab/switches", Map.of("visitorId", byHand, "experiment", exp, "assigned", "a",
                "from", "a", "to", "b", "source", "customize"), null);
        call(HttpMethod.POST, "/api/ab/switches", Map.of("visitorId", inTest, "experiment", exp, "assigned", "a",
                "from", "a", "to", "b", "source", "taste_test"), null);
        assertThat(call(HttpMethod.POST, "/api/ab/switches", Map.of("visitorId", inTest, "experiment", exp, "assigned", "a",
                "from", "b", "to", "a", "source", "elsewhere"), null).getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);

        String admin = token("admin", "admin12345");
        JsonNode a = variant(Json.read(call(HttpMethod.GET, "/api/admin/ab/results", null, admin).getBody()), exp, "a");
        assertThat(a.path("visitors").asLong()).isEqualTo(2);
        assertThat(a.path("switchedAway").asLong()).isEqualTo(1);
        assertThat(a.path("pickedInTasteTest").asLong()).isEqualTo(1);

        JsonNode rows = Json.read(call(HttpMethod.GET, "/api/admin/ab/visitors", null, admin).getBody());
        JsonNode row = null;
        for (JsonNode r : rows) {
            if (r.path("visitorId").asText().equals(byHand.toString())) {
                row = r;
            }
        }
        assertThat(row).isNotNull();
        assertThat(row.path("assigned").path(exp).asText()).isEqualTo("a");
        assertThat(row.path("current").path(exp).asText()).isEqualTo("b");
        assertThat(row.path("switchesByHand").asLong()).isEqualTo(1);
    }

    @Test
    void aOneTapRatingCanGetReasonsAddedByTheSameVisitorOnly() {
        UUID visitor = UUID.randomUUID();
        var created = call(HttpMethod.POST, "/api/feedback", Map.of("visitorId", visitor, "rating", 4, "category", "general",
                "path", "/slots", "source", "pulse", "variants", Map.of("music", "lounge")), null);
        assertThat(created.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        long id = Json.read(created.getBody()).path("id").asLong();
        assertThat(id).isPositive();

        // Someone else can't add to it, and unknown tags are refused.
        assertThat(call(HttpMethod.POST, "/api/feedback/" + id + "/details", Map.of("visitorId", UUID.randomUUID(),
                "tags", List.of("love_music")), null).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(call(HttpMethod.POST, "/api/feedback/" + id + "/details", Map.of("visitorId", visitor,
                "tags", List.of("<b>")), null).getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(call(HttpMethod.POST, "/api/feedback/" + id + "/details", Map.of("visitorId", visitor,
                "tags", List.of("love_music", "looks_great"), "message", "The lounge music fits"), null).getStatusCode())
                .isEqualTo(HttpStatus.NO_CONTENT);

        String admin = token("admin", "admin12345");
        JsonNode list = Json.read(call(HttpMethod.GET, "/api/admin/feedback?experiment=music&variant=lounge", null, admin).getBody());
        JsonNode mine = null;
        for (JsonNode f : list) {
            if (f.path("id").asLong() == id) {
                mine = f;
            }
        }
        assertThat(mine).isNotNull();
        assertThat(mine.path("source").asText()).isEqualTo("pulse");
        assertThat(mine.path("category").asText()).isEqualTo("general");
        assertThat(mine.path("message").asText()).isEqualTo("The lounge music fits");
        assertThat(List.of(mine.path("tags").get(0).asText(), mine.path("tags").get(1).asText()))
                .containsExactlyInAnyOrder("love_music", "looks_great");
    }

    @Test
    void oneClassroomOnOneAddressIsNotRateLimitedAsOneVisitor() {
        // 30 visitors behind the same address (a school network) each send a rating: all of them count.
        for (int i = 0; i < 30; i++) {
            assertThat(call(HttpMethod.POST, "/api/feedback", Map.of("visitorId", UUID.randomUUID(), "rating", 5,
                    "category", "general", "path", "/", "source", "pulse"), null).getStatusCode()).isEqualTo(HttpStatus.CREATED);
        }
        // One visitor sending many is still stopped.
        UUID spammer = UUID.randomUUID();
        int last = 0;
        for (int i = 0; i < 8; i++) {
            last = call(HttpMethod.POST, "/api/feedback", Map.of("visitorId", spammer, "rating", 1,
                    "category", "general", "path", "/"), null).getStatusCode().value();
        }
        assertThat(last).isEqualTo(HttpStatus.TOO_MANY_REQUESTS.value());
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
