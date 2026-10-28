package win.naebka;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import java.math.BigDecimal;
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

/** HTTP-level checks: auth, RFC 7807 errors, slots and poker money flows. */
class ApiIT extends IntegrationTestBase {
    @Autowired
    TestRestTemplate http;

    String token;

    String login() {
        String name = "api" + UUID.randomUUID().toString().substring(0, 8);
        var res = http.postForEntity("/api/auth/register", Map.of("username", name, "email", name + "@t.local",
                "password", "password123", "dateOfBirth", "1990-01-01", "country", "CZ"), String.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        return Json.read(res.getBody()).path("token").asText();
    }

    ResponseEntity<String> call(HttpMethod method, String path, Object body, String bearer) {
        HttpHeaders h = new HttpHeaders();
        h.setContentType(MediaType.APPLICATION_JSON);
        if (bearer != null) {
            h.setBearerAuth(bearer);
        }
        h.set("Idempotency-Key", UUID.randomUUID().toString());
        return http.exchange(path, method, new HttpEntity<>(body == null ? null : Json.write(body), h), String.class);
    }

    JsonNode json(ResponseEntity<String> r) {
        return Json.read(r.getBody());
    }

    @Test
    void underageRegistrationIsRejectedAsProblemJson() {
        var res = http.postForEntity("/api/auth/register", Map.of("username", "kid" + System.nanoTime() % 100000,
                "email", "kid@t.local", "password", "password123", "dateOfBirth", "2015-01-01", "country", "CZ"), String.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY);
        assertThat(res.getHeaders().getContentType().toString()).contains("problem+json");
        assertThat(json(res).path("code").asText()).isEqualTo("UNDERAGE");
    }

    @Test
    void walletNeedsAuthAndLogoutRevokesTheToken() {
        assertThat(call(HttpMethod.GET, "/api/wallet", null, null).getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
        String t = login();
        var wallet = call(HttpMethod.GET, "/api/wallet", null, t);
        assertThat(json(wallet).path("balance").decimalValue()).isEqualByComparingTo("1000.00");
        assertThat(call(HttpMethod.POST, "/api/auth/logout", null, t).getStatusCode()).isEqualTo(HttpStatus.NO_CONTENT);
        assertThat(call(HttpMethod.GET, "/api/wallet", null, t).getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
    }

    @Test
    void withdrawalNeedsVerifiedIdentity() {
        String t = login();
        var res = call(HttpMethod.POST, "/api/wallet/withdrawals", Map.of("amountTokens", 10), t);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(json(res).path("code").asText()).isEqualTo("KYC_REQUIRED");
        assertThat(json(call(HttpMethod.GET, "/api/kyc", null, t)).path("status").asText()).isEqualTo("NONE");
    }

    @Test
    void depositWithoutIdempotencyKeyIsRejected() {
        String t = login();
        HttpHeaders h = new HttpHeaders();
        h.setContentType(MediaType.APPLICATION_JSON);
        h.setBearerAuth(t);
        var res = http.exchange("/api/wallet/deposits", HttpMethod.POST,
                new HttpEntity<>(Json.write(Map.of("amountTokens", 10)), h), String.class);
        assertThat(json(res).path("code").asText()).isEqualTo("IDEMPOTENCY_KEY_REQUIRED");
    }

    @Test
    void slotSpinMovesMoneyThroughTheLedgerAndIsVerifiable() {
        String t = login();
        var spin = call(HttpMethod.POST, "/api/slots/spin", Map.of("betPerLine", "0.10"), t);
        assertThat(spin.getStatusCode()).isEqualTo(HttpStatus.OK);
        JsonNode s = json(spin);
        BigDecimal expected = new BigDecimal("1000.00").subtract(new BigDecimal("1.00")).add(s.path("totalWin").decimalValue());
        if (s.path("freeSpinsRemaining").asInt() == 0 && !s.path("isBonusGameTriggered").asBoolean()) {
            assertThat(s.path("balance").decimalValue()).isEqualByComparingTo(expected);
        }
        assertThat(s.path("grid")).hasSize(5);

        var notYet = json(call(HttpMethod.GET, "/api/slots/rounds/" + s.path("spinId").asText() + "/verify", null, t));
        assertThat(notYet.path("verifiable").asBoolean()).isFalse();
        var rotated = json(call(HttpMethod.POST, "/api/slots/fairness/rotate", Map.of("clientSeed", "my-seed"), t));
        assertThat(rotated.path("clientSeed").asText()).isEqualTo("my-seed");
        var verified = json(call(HttpMethod.GET, "/api/slots/rounds/" + s.path("spinId").asText() + "/verify", null, t));
        assertThat(verified.path("verified").asBoolean()).isTrue();
    }

    @Test
    void pokerBuyInAndCashOutConserveMoney() {
        String t = login();
        JsonNode tables = json(call(HttpMethod.GET, "/api/poker/tables", null, t));
        String tableId = tables.get(0).path("id").asText();
        var sit = call(HttpMethod.POST, "/api/poker/tables/" + tableId + "/sit", Map.of("seatNo", 5, "buyInTokens", "50"), t);
        assertThat(sit.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(json(call(HttpMethod.GET, "/api/wallet", null, t)).path("balance").decimalValue()).isEqualByComparingTo("950.00");
        var again = call(HttpMethod.POST, "/api/poker/tables/" + tableId + "/sit", Map.of("seatNo", 4, "buyInTokens", "50"), t);
        assertThat(json(again).path("code").asText()).isEqualTo("ALREADY_SEATED");
        var leave = call(HttpMethod.POST, "/api/poker/tables/" + tableId + "/leave", null, t);
        assertThat(json(leave).path("left").asBoolean()).isTrue();
        assertThat(json(call(HttpMethod.GET, "/api/wallet", null, t)).path("balance").decimalValue()).isEqualByComparingTo("1000.00");
    }
}
