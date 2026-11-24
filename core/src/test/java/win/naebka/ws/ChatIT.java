package win.naebka.ws;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import win.naebka.IntegrationTestBase;
import win.naebka.common.Json;

/** Chat rooms over HTTP, with new messages pushed live on chat:{roomId}. */
class ChatIT extends IntegrationTestBase {
    @LocalServerPort
    int port;
    @Autowired
    TestRestTemplate http;

    String token() {
        String name = "chat" + UUID.randomUUID().toString().substring(0, 8);
        var res = http.postForEntity("/api/auth/register", Map.of("username", name, "email", name + "@t.local",
                "password", "password123", "dateOfBirth", "1990-01-01", "country", "CZ"), String.class);
        return Json.read(res.getBody()).path("token").asText();
    }

    ResponseEntity<String> call(HttpMethod method, String path, Object body, String bearer) {
        HttpHeaders h = new HttpHeaders();
        h.setContentType(MediaType.APPLICATION_JSON);
        if (bearer != null) {
            h.setBearerAuth(bearer);
        }
        return http.exchange(path, method, new HttpEntity<>(body == null ? null : Json.write(body), h), String.class);
    }

    String globalRoom() {
        JsonNode rooms = Json.read(call(HttpMethod.GET, "/api/chat/rooms", null, null).getBody());
        for (JsonNode r : rooms) {
            if ("Global".equals(r.path("name").asText())) {
                assertThat(r.path("matchId").isMissingNode() || r.path("matchId").isNull()).isTrue();
                return r.path("id").asText();
            }
        }
        throw new AssertionError("the seeded Global room is missing");
    }

    String messages(String room) {
        return "/api/chat/rooms/" + room + "/messages";
    }

    @Test
    void postedMessagesAreStoredAndPushedLive() throws Exception {
        String room = globalRoom();
        String t = token();
        try (TestSocket ws = new TestSocket(port, "/ws")) {
            ws.send(Map.of("op", "subscribe", "topic", "chat:" + room));
            ws.awaitType("SUBSCRIBED");

            var posted = call(HttpMethod.POST, messages(room), Map.of("message", "  gl hf  "), t);
            assertThat(posted.getStatusCode()).isEqualTo(HttpStatus.CREATED);
            JsonNode msg = Json.read(posted.getBody());
            assertThat(msg.path("message").asText()).isEqualTo("gl hf"); // stripped

            JsonNode pushed = ws.awaitType("CHAT_MESSAGE");
            assertThat(pushed.path("data").path("id").asText()).isEqualTo(msg.path("id").asText());
            assertThat(pushed.path("data").path("username").asText()).isEqualTo(msg.path("username").asText());
        }

        call(HttpMethod.POST, messages(room), Map.of("message", "second"), t);
        JsonNode history = Json.read(call(HttpMethod.GET, messages(room), null, null).getBody());
        // Oldest first, and the two we just sent are the newest
        assertThat(history.get(history.size() - 2).path("message").asText()).isEqualTo("gl hf");
        assertThat(history.get(history.size() - 1).path("message").asText()).isEqualTo("second");
    }

    @Test
    void readingIsPublicButPostingNeedsLogin() {
        String room = globalRoom();
        assertThat(call(HttpMethod.GET, messages(room), null, null).getStatusCode()).isEqualTo(HttpStatus.OK);
        var anonymous = call(HttpMethod.POST, messages(room), Map.of("message", "hi"), null);
        assertThat(anonymous.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
    }

    @Test
    void invalidMessagesAndUnknownRoomsAreRejected() {
        String room = globalRoom();
        String t = token();
        assertThat(call(HttpMethod.POST, messages(room), Map.of("message", "   "), t).getStatusCode())
                .isEqualTo(HttpStatus.BAD_REQUEST);
        // Boundary: 500 characters is the maximum
        assertThat(call(HttpMethod.POST, messages(room), Map.of("message", "x".repeat(500)), t).getStatusCode())
                .isEqualTo(HttpStatus.CREATED);
        assertThat(call(HttpMethod.POST, messages(room), Map.of("message", "x".repeat(501)), t).getStatusCode())
                .isEqualTo(HttpStatus.BAD_REQUEST);
        var unknown = call(HttpMethod.POST, messages(UUID.randomUUID().toString()), Map.of("message", "hi"), t);
        assertThat(unknown.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(Json.read(call(HttpMethod.GET, messages(UUID.randomUUID().toString()), null, null).getBody()))
                .isEmpty();
    }

    @Test
    void elevenMessagesIn30SecondsIsRateLimited() {
        String room = globalRoom();
        String t = token();
        for (int i = 1; i <= 10; i++) {
            assertThat(call(HttpMethod.POST, messages(room), Map.of("message", "spam " + i), t).getStatusCode())
                    .isEqualTo(HttpStatus.CREATED);
        }
        var eleventh = call(HttpMethod.POST, messages(room), Map.of("message", "spam 11"), t);
        assertThat(eleventh.getStatusCode()).isEqualTo(HttpStatus.TOO_MANY_REQUESTS);
        assertThat(Json.read(eleventh.getBody()).path("code").asText()).isEqualTo("RATE_LIMITED");
    }
}
