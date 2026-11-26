package win.naebka.ws;

import com.fasterxml.jackson.databind.JsonNode;
import java.net.URI;
import java.util.Map;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.function.Predicate;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketHttpHeaders;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.client.standard.StandardWebSocketClient;
import org.springframework.web.socket.handler.TextWebSocketHandler;
import win.naebka.common.Json;

/** A real WebSocket client for tests: sends JSON frames and waits for the frames the server sends back. */
public class TestSocket implements AutoCloseable {
    private final BlockingQueue<JsonNode> inbox = new LinkedBlockingQueue<>();
    private final WebSocketSession session;

    public TestSocket(int port, String path) throws Exception {
        session = new StandardWebSocketClient().execute(new TextWebSocketHandler() {
            @Override
            protected void handleTextMessage(WebSocketSession s, TextMessage message) {
                inbox.add(Json.read(message.getPayload()));
            }
        }, new WebSocketHttpHeaders(), URI.create("ws://localhost:" + port + path)).get(5, TimeUnit.SECONDS);
    }

    public void send(Map<String, Object> frame) throws Exception {
        sendRaw(Json.write(frame));
    }

    void sendRaw(String text) throws Exception {
        session.sendMessage(new TextMessage(text));
    }

    /** The next frame that matches, skipping others; fails after 5 s. */
    public JsonNode await(Predicate<JsonNode> match) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (System.nanoTime() < deadline) {
            JsonNode next = inbox.poll(100, TimeUnit.MILLISECONDS);
            if (next != null && match.test(next)) {
                return next;
            }
        }
        throw new AssertionError("no matching WebSocket frame within 5 s");
    }

    public JsonNode awaitType(String type) throws InterruptedException {
        return await(f -> type.equals(f.path("type").asText()));
    }

    /** True if no frame matching arrives within the given time (for "must NOT be delivered" checks). */
    public boolean nothingFor(long millis, Predicate<JsonNode> match) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(millis);
        while (System.nanoTime() < deadline) {
            JsonNode next = inbox.poll(50, TimeUnit.MILLISECONDS);
            if (next != null && match.test(next)) {
                return false;
            }
        }
        return true;
    }

    boolean isOpen() {
        return session.isOpen();
    }

    @Override
    public void close() throws Exception {
        if (session.isOpen()) {
            session.close();
        }
    }
}
