package win.naebka;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Base64;
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
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.security.oauth2.jose.jws.MacAlgorithm;
import org.springframework.security.oauth2.jwt.JwsHeader;
import org.springframework.security.oauth2.jwt.JwtClaimsSet;
import org.springframework.security.oauth2.jwt.JwtEncoderParameters;
import org.springframework.security.oauth2.jwt.NimbusJwtEncoder;
import com.nimbusds.jose.jwk.source.ImmutableSecret;
import javax.crypto.spec.SecretKeySpec;
import win.naebka.common.Json;
import win.naebka.config.NaebkaProperties;

/**
 * Security checks (OWASP Top 10): access control on admin endpoints, forged and expired tokens, acting on another
 * user's data, injection attempts and the browser security headers.
 */
class SecurityIT extends IntegrationTestBase {
    @Autowired
    TestRestTemplate http;
    @Autowired
    JdbcClient jdbc;
    @Autowired
    NaebkaProperties props;

    record Player(UUID id, String username, String token) {}

    Player register() {
        String name = "sec" + UUID.randomUUID().toString().substring(0, 8);
        var res = http.postForEntity("/api/auth/register", Map.of("username", name, "email", name + "@t.local",
                "password", "password123", "dateOfBirth", "1990-01-01", "country", "CZ"), String.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        JsonNode body = Json.read(res.getBody());
        return new Player(UUID.fromString(body.path("user").path("id").asText()), name, body.path("token").asText());
    }

    String loginToken(String username) {
        var res = http.postForEntity("/api/auth/login", Map.of("username", username, "password", "password123"),
                String.class);
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

    /** A token for the player's real, still-active session, signed with the given secret and expiry. */
    static String sign(Player player, String secret, Instant issuedAt, Instant expiresAt) {
        String session = Json.read(new String(Base64.getUrlDecoder().decode(player.token().split("\\.")[1]),
                StandardCharsets.UTF_8)).path("jti").asText();
        var key = new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256");
        JwtClaimsSet claims = JwtClaimsSet.builder().issuer("naebka").subject(player.id().toString()).id(session)
                .issuedAt(issuedAt).expiresAt(expiresAt).claim("username", player.username()).claim("role", "PLAYER")
                .build();
        return new NimbusJwtEncoder(new ImmutableSecret<>(key))
                .encode(JwtEncoderParameters.from(JwsHeader.with(MacAlgorithm.HS256).build(), claims)).getTokenValue();
    }

    static String b64(String json) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(json.getBytes(StandardCharsets.UTF_8));
    }

    /** A01 broken access control: admin endpoints need the ADMIN role, not just a login. */
    @Test
    void adminEndpointsRejectAnonymousUsersAndPlayers() {
        Player player = register();
        for (String path : new String[] {"/api/admin/health", "/api/admin/feedback", "/api/admin/kyc/queue"}) {
            assertThat(call(HttpMethod.GET, path, null, null).getStatusCode()).as(path).isEqualTo(HttpStatus.UNAUTHORIZED);
            assertThat(call(HttpMethod.GET, path, null, player.token()).getStatusCode()).as(path).isEqualTo(HttpStatus.FORBIDDEN);
        }
        var approve = call(HttpMethod.POST, "/api/admin/kyc/submissions/" + UUID.randomUUID() + "/approve", null,
                player.token());
        assertThat(approve.getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);

        // The same account after being made an admin (the role is read at login)
        jdbc.sql("UPDATE users SET role = 'ADMIN' WHERE id = ?").param(player.id()).update();
        String adminToken = loginToken(player.username());
        assertThat(call(HttpMethod.GET, "/api/admin/health", null, adminToken).getStatusCode()).isEqualTo(HttpStatus.OK);
    }

    /** A07 authentication failures: a token whose payload was edited to claim ADMIN is rejected. */
    @Test
    void aTokenEditedToClaimAdminIsRejected() {
        Player player = register();
        String[] parts = player.token().split("\\.");
        String payload = new String(Base64.getUrlDecoder().decode(parts[1]), StandardCharsets.UTF_8);
        assertThat(payload).contains("\"PLAYER\"");
        String forged = parts[0] + "." + b64(payload.replace("\"PLAYER\"", "\"ADMIN\"")) + "." + parts[2];
        assertThat(call(HttpMethod.GET, "/api/admin/health", null, forged).getStatusCode())
                .isEqualTo(HttpStatus.UNAUTHORIZED);
        assertThat(call(HttpMethod.GET, "/api/wallet", null, forged).getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
    }

    /** A07: unsigned ("alg": "none"), expired, and wrongly signed tokens are all rejected. */
    @Test
    void unsignedAndExpiredTokensAreRejected() {
        Player player = register();
        long now = Instant.now().getEpochSecond();
        String unsigned = b64("{\"alg\":\"none\",\"typ\":\"JWT\"}") + "." + b64("{\"sub\":\"" + player.id()
                + "\",\"role\":\"ADMIN\",\"username\":\"x\",\"jti\":\"" + UUID.randomUUID() + "\",\"exp\":" + (now + 3600)
                + "}") + ".";
        assertThat(call(HttpMethod.GET, "/api/wallet", null, unsigned).getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);

        Instant hourAgo = Instant.now().minusSeconds(3600);
        String fresh = sign(player, props.jwt().secret(), Instant.now(), Instant.now().plusSeconds(600));
        assertThat(call(HttpMethod.GET, "/api/wallet", null, fresh).getStatusCode()).isEqualTo(HttpStatus.OK);

        String expired = sign(player, props.jwt().secret(), hourAgo.minusSeconds(3600), hourAgo);
        assertThat(call(HttpMethod.GET, "/api/wallet", null, expired).getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);

        String otherKey = sign(player, "an-attacker-guessed-secret-of-32-bytes!!", Instant.now(),
                Instant.now().plusSeconds(600));
        assertThat(call(HttpMethod.GET, "/api/wallet", null, otherKey).getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
    }

    /** A01 insecure direct object reference: a user can't log another user out by guessing their session id. */
    @Test
    void aUserCannotRevokeSomeoneElsesSession() {
        Player victim = register();
        Player attacker = register();
        JsonNode sessions = Json.read(call(HttpMethod.GET, "/api/auth/sessions", null, victim.token()).getBody());
        String victimSession = sessions.get(0).path("id").asText();

        call(HttpMethod.DELETE, "/api/auth/sessions/" + victimSession, null, attacker.token());
        assertThat(call(HttpMethod.GET, "/api/wallet", null, victim.token()).getStatusCode()).isEqualTo(HttpStatus.OK);
        // The attacker's list never shows other people's sessions
        assertThat(call(HttpMethod.GET, "/api/auth/sessions", null, attacker.token()).getBody()).doesNotContain(victimSession);
    }

    /** A03 injection: SQL in a login or a chat message is treated as plain text. */
    @Test
    void sqlInjectionAttemptsAreTreatedAsText() {
        var login = http.postForEntity("/api/auth/login", Map.of("username", "' OR '1'='1' --", "password", "x' OR '1'='1"),
                String.class);
        assertThat(login.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);

        var badName = http.postForEntity("/api/auth/register", Map.of("username", "x'; DROP TABLE users;--",
                "email", "inj@t.local", "password", "password123", "dateOfBirth", "1990-01-01", "country", "CZ"), String.class);
        assertThat(badName.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);

        Player player = register();
        String room = jdbc.sql("SELECT id FROM chat_rooms WHERE name = 'Global'").query(String.class).single();
        String evil = "'); DELETE FROM chat_messages; --";
        var posted = call(HttpMethod.POST, "/api/chat/rooms/" + room + "/messages", Map.of("message", evil), player.token());
        assertThat(Json.read(posted.getBody()).path("message").asText()).isEqualTo(evil);
        long users = jdbc.sql("SELECT count(*) FROM users").query(Long.class).single();
        assertThat(users).isPositive();
        assertThat(jdbc.sql("SELECT count(*) FROM chat_messages WHERE message = ?").param(evil).query(Long.class).single())
                .isEqualTo(1);
    }

    /** A05 security misconfiguration: pages and API answers carry the browser security headers. */
    @Test
    void responsesCarryTheSecurityHeaders() {
        for (String path : new String[] {"/api/config", "/"}) {
            HttpHeaders h = http.getForEntity(path, String.class).getHeaders();
            String csp = h.getFirst("Content-Security-Policy");
            assertThat(csp).as(path).contains("script-src 'self'").contains("frame-ancestors 'none'")
                    .contains("object-src 'none'").doesNotContain("unsafe-eval");
            assertThat(h.getFirst("X-Content-Type-Options")).as(path).isEqualTo("nosniff");
            assertThat(h.getFirst("X-Frame-Options")).as(path).isEqualTo("DENY");
            assertThat(h.getFirst("Referrer-Policy")).as(path).isEqualTo("strict-origin-when-cross-origin");
            assertThat(h.getFirst("Permissions-Policy")).as(path).contains("camera=()");
        }
    }
}
