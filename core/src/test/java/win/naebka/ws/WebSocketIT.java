package win.naebka.ws;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import win.naebka.IntegrationTestBase;

/**
 * The WebSocket protocol end to end: a real client against the running server, with Redis carrying the fan-out
 * (auth, subscriptions and their rules, replay after a reconnect, commit-only delivery, error frames).
 */
class WebSocketIT extends IntegrationTestBase {
    @LocalServerPort
    int port;
    @Autowired
    WsHub hub;
    @Autowired
    NaebkaWebSocketHandler handler;
    @Autowired
    JdbcClient jdbc;
    @Autowired
    PlatformTransactionManager txManager;

    TestSocket connect() throws Exception {
        return new TestSocket(port, "/ws");
    }

    /** A new user and a valid JWT for them. */
    record Login(UUID id, String token) {}

    Login login() {
        UUID id = newUser();
        String username = jdbc.sql("SELECT username FROM users WHERE id = ?").param(id).query(String.class).single();
        String ip = "10.2." + (int) (Math.random() * 250) + "." + (int) (Math.random() * 250);
        return new Login(id, auth.login(username, "password123", ip, "test").token());
    }

    static String error(JsonNode frame) {
        return frame.path("error").asText();
    }

    static String freshTopic() {
        return "chat:" + UUID.randomUUID();
    }

    @Test
    void pingGetsPong() throws Exception {
        try (TestSocket ws = connect()) {
            ws.send(Map.of("op", "ping"));
            assertThat(ws.awaitType("PONG")).isNotNull();
        }
    }

    @Test
    void badFramesGetErrorFrames() throws Exception {
        try (TestSocket ws = connect()) {
            ws.sendRaw("{not json");
            assertThat(error(ws.awaitType("ERROR"))).isEqualTo("VALIDATION_FAILED");

            ws.send(Map.of("op", "dance"));
            JsonNode unknown = ws.awaitType("ERROR");
            assertThat(unknown.path("message").asText()).contains("Unknown op dance");
            assertThat(unknown.path("code").asInt()).isEqualTo(2012);

            // Game commands need a logged-in socket
            ws.send(Map.of("op", "poker.action", "tableId", UUID.randomUUID().toString()));
            assertThat(error(ws.awaitType("ERROR"))).isEqualTo("UNAUTHORIZED");
        }
    }

    @Test
    void authWithValidTokenSubscribesToOwnTopicAndTracksPresence() throws Exception {
        Login me = login();
        TestSocket ws = connect();
        ws.send(Map.of("op", "auth", "token", "not-a-jwt"));
        assertThat(error(ws.awaitType("ERROR"))).isEqualTo("UNAUTHORIZED");
        assertThat(handler.isOnline(me.id())).isFalse();

        ws.send(Map.of("op", "auth", "token", me.token()));
        assertThat(ws.awaitType("AUTH_OK").path("userId").asText()).isEqualTo(me.id().toString());
        assertThat(ws.awaitType("SUBSCRIBED").path("topic").asText()).isEqualTo("user:" + me.id());
        assertThat(handler.isOnline(me.id())).isTrue();

        ws.close();
        long deadline = System.currentTimeMillis() + 5_000;
        while (handler.isOnline(me.id()) && System.currentTimeMillis() < deadline) {
            Thread.sleep(50);
        }
        assertThat(handler.isOnline(me.id())).isFalse();
    }

    @Test
    void presenceCountsEverySocketOfAUser() throws Exception {
        Login me = login();
        try (TestSocket first = connect(); TestSocket second = connect()) {
            first.send(Map.of("op", "auth", "token", me.token()));
            first.awaitType("AUTH_OK");
            second.send(Map.of("op", "auth", "token", me.token()));
            second.awaitType("AUTH_OK");

            first.close();
            Thread.sleep(300);
            // The second tab is still open
            assertThat(handler.isOnline(me.id())).isTrue();
        }
    }

    @Test
    void onlyPublicTopicsAndYourOwnUserTopicCanBeSubscribed() throws Exception {
        Login me = login();
        Login other = login();
        try (TestSocket ws = connect()) {
            ws.send(Map.of("op", "subscribe", "topic", "user:" + other.id()));
            assertThat(error(ws.awaitType("ERROR"))).isEqualTo("FORBIDDEN");
            ws.send(Map.of("op", "subscribe", "topic", "admin-secrets"));
            assertThat(error(ws.awaitType("ERROR"))).isEqualTo("FORBIDDEN");

            ws.send(Map.of("op", "subscribe", "topic", "lobby"));
            assertThat(ws.awaitType("SUBSCRIBED").path("topic").asText()).isEqualTo("lobby");

            ws.send(Map.of("op", "auth", "token", me.token()));
            ws.awaitType("AUTH_OK");
            ws.send(Map.of("op", "subscribe", "topic", "user:" + me.id()));
            assertThat(ws.await(f -> "SUBSCRIBED".equals(f.path("type").asText())
                    && f.path("topic").asText().equals("user:" + me.id()))).isNotNull();
        }
    }

    @Test
    void lobbyAndMatchPathsSubscribeAutomatically() throws Exception {
        try (TestSocket lobby = new TestSocket(port, "/ws/lobby")) {
            assertThat(lobby.awaitType("SUBSCRIBED").path("topic").asText()).isEqualTo("lobby");
        }
        UUID matchId = UUID.randomUUID();
        try (TestSocket match = new TestSocket(port, "/ws/matches/" + matchId)) {
            assertThat(match.awaitType("SUBSCRIBED").path("topic").asText()).isEqualTo("match:" + matchId);
        }
    }

    @Test
    void publishedMessagesReachSubscribersUntilTheyUnsubscribe() throws Exception {
        String topic = freshTopic();
        try (TestSocket ws = connect()) {
            ws.send(Map.of("op", "subscribe", "topic", topic));
            ws.awaitType("SUBSCRIBED");
            assertThat(handler.subscribedTopics("chat:")).contains(topic);

            hub.publish(topic, "CHAT_MESSAGE", Map.of("message", "hello"));
            JsonNode msg = ws.awaitType("CHAT_MESSAGE");
            assertThat(msg.path("topic").asText()).isEqualTo(topic);
            assertThat(msg.path("seq").asLong()).isEqualTo(1);
            assertThat(msg.path("data").path("message").asText()).isEqualTo("hello");

            ws.send(Map.of("op", "unsubscribe", "topic", topic));
            ws.send(Map.of("op", "ping"));
            ws.awaitType("PONG"); // frames are handled in order, so the unsubscribe is done
            hub.publish(topic, "CHAT_MESSAGE", Map.of("message", "nobody hears this"));
            assertThat(ws.nothingFor(700, f -> "CHAT_MESSAGE".equals(f.path("type").asText()))).isTrue();
        }
    }

    @Test
    void reconnectWithLastSeqReplaysWhatWasMissed() throws Exception {
        String topic = freshTopic();
        for (int i = 1; i <= 3; i++) {
            hub.publish(topic, "CHAT_MESSAGE", Map.of("n", i));
        }
        assertThat(hub.currentSeq(topic)).isEqualTo(3);
        assertThat(hub.replay(topic, 0)).hasSize(3);

        try (TestSocket ws = connect()) {
            ws.send(Map.of("op", "subscribe", "topic", topic, "lastSeq", 1));
            assertThat(ws.awaitType("CHAT_MESSAGE").path("seq").asLong()).isEqualTo(2);
            assertThat(ws.awaitType("CHAT_MESSAGE").path("seq").asLong()).isEqualTo(3);
            assertThat(ws.awaitType("SUBSCRIBED").path("seq").asLong()).isEqualTo(3);
        }
        assertThat(hub.replay("chat:" + UUID.randomUUID(), 0)).isEmpty();
    }

    @Test
    void messagesPublishedInATransactionAreSentOnlyAfterCommit() throws Exception {
        String topic = freshTopic();
        TransactionTemplate tx = new TransactionTemplate(txManager);
        try (TestSocket ws = connect()) {
            ws.send(Map.of("op", "subscribe", "topic", topic));
            ws.awaitType("SUBSCRIBED");

            tx.executeWithoutResult(status -> {
                hub.publish(topic, "BALANCE", Map.of("v", "rolled back"));
                status.setRollbackOnly();
            });
            assertThat(ws.nothingFor(700, f -> "BALANCE".equals(f.path("type").asText()))).isTrue();

            tx.executeWithoutResult(status -> hub.publish(topic, "BALANCE", Map.of("v", "committed")));
            assertThat(ws.awaitType("BALANCE").path("data").path("v").asText()).isEqualTo("committed");
        }
    }

    @Test
    void transientMessagesAndDirectMessagesAreDelivered() throws Exception {
        Login me = login();
        String topic = freshTopic();
        try (TestSocket ws = connect()) {
            ws.send(Map.of("op", "auth", "token", me.token()));
            ws.awaitType("AUTH_OK");
            ws.send(Map.of("op", "subscribe", "topic", topic));
            ws.await(f -> topic.equals(f.path("topic").asText()) && "SUBSCRIBED".equals(f.path("type").asText()));

            hub.publishTransient(topic, "FRAME", Map.of("x", 1));
            assertThat(ws.awaitType("FRAME").path("data").path("x").asInt()).isEqualTo(1);
            assertThat(hub.currentSeq(topic)).isZero(); // transient messages are not counted or buffered

            handler.sendToUser(me.id(), Map.of("type", "POKER_SYNC"));
            assertThat(ws.awaitType("POKER_SYNC")).isNotNull();

            hub.publishToUser(me.id(), "WALLET", Map.of("balance", 10));
            assertThat(ws.awaitType("WALLET").path("topic").asText()).isEqualTo("user:" + me.id());
        }
    }

    @Test
    void theRealtimeMapNeedsPermission() throws Exception {
        try (TestSocket anonymous = connect()) {
            anonymous.send(Map.of("op", "subscribe", "topic", "watch:123456"));
            JsonNode denied = anonymous.awaitType("WATCH_DENIED");
            assertThat(denied.path("data").path("reason").asText()).isEqualTo("LOGIN_REQUIRED");
        }
        Login admin = login();
        jdbc.sql("UPDATE users SET role = 'ADMIN' WHERE id = ?").param(admin.id()).update();
        try (TestSocket ws = connect()) {
            ws.send(Map.of("op", "auth", "token", admin.token()));
            ws.awaitType("AUTH_OK");
            ws.send(Map.of("op", "subscribe", "topic", "watch:123456"));
            assertThat(ws.await(f -> "watch:123456".equals(f.path("topic").asText())
                    && "SUBSCRIBED".equals(f.path("type").asText()))).isNotNull();
            assertThat(handler.subscribedTopics("watch:")).contains("watch:123456");
        }
    }
}
