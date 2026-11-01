package win.naebka;

import java.time.LocalDate;
import java.util.UUID;
import org.junit.jupiter.api.Tag;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.PostgreSQLContainer;
import win.naebka.auth.AuthService;

/**
 * Boots the whole core against real PostgreSQL and Redis containers (needs Docker).
 * Run with {@code mvn -Pit test}.
 */
@Tag("integration")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
        "naebka.betting.acceptance-delay-ms=0",
        "naebka.settlement.poll-seconds=3600",
        "naebka.poker.block-same-ip=false"
})
public abstract class IntegrationTestBase {
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>("postgres:17-alpine");
    static final GenericContainer<?> REDIS = new GenericContainer<>("redis:7-alpine").withExposedPorts(6379);

    static {
        POSTGRES.start();
        REDIS.start();
    }

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry r) {
        r.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        r.add("spring.datasource.username", POSTGRES::getUsername);
        r.add("spring.datasource.password", POSTGRES::getPassword);
        r.add("spring.data.redis.host", REDIS::getHost);
        r.add("spring.data.redis.port", () -> REDIS.getMappedPort(6379));
    }

    @Autowired
    protected AuthService auth;

    protected UUID newUser() {
        String name = "u" + UUID.randomUUID().toString().substring(0, 8);
        return auth.register(name, name + "@test.local", "password123", LocalDate.of(1995, 5, 5), "CZ");
    }
}
