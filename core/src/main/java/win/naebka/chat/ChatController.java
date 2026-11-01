package win.naebka.chat;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.transaction.annotation.Transactional;
import win.naebka.auth.AuthUser;
import win.naebka.common.Exceptions;
import win.naebka.common.RateLimiter;
import win.naebka.ws.WsHub;

/** Global and per-match chat rooms. New messages are pushed on topic chat:{roomId}. */
@RestController
public class ChatController {
    private final JdbcClient jdbc;
    private final WsHub ws;
    private final RateLimiter rateLimiter;

    public ChatController(JdbcClient jdbc, WsHub ws, RateLimiter rateLimiter) {
        this.jdbc = jdbc;
        this.ws = ws;
        this.rateLimiter = rateLimiter;
    }

    public record RoomView(UUID id, UUID matchId, String name) {}

    public record MessageView(UUID id, UUID roomId, String username, String message, Instant createdAt) {}

    public record PostRequest(@NotBlank @Size(max = 500) String message) {}

    @GetMapping("/api/chat/rooms")
    public List<RoomView> globalRooms() {
        return jdbc.sql("SELECT id, match_id, name FROM chat_rooms WHERE match_id IS NULL ORDER BY name")
                .query((rs, i) -> new RoomView(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class), rs.getString(3)))
                .list();
    }

    @GetMapping("/api/chat/rooms/{roomId}/messages")
    public List<MessageView> latest(@PathVariable UUID roomId) {
        List<MessageView> newestFirst = jdbc.sql("""
                SELECT m.id, m.room_id, u.username, m.message, m.created_at FROM chat_messages m
                JOIN users u ON u.id = m.user_id WHERE m.room_id = ? ORDER BY m.created_at DESC LIMIT 50""")
                .param(roomId).query(ChatController::map).list();
        return newestFirst.reversed();
    }

    @PostMapping("/api/chat/rooms/{roomId}/messages")
    @ResponseStatus(HttpStatus.CREATED)
    @Transactional
    public MessageView post(@PathVariable UUID roomId, @Valid @RequestBody PostRequest req) {
        AuthUser me = AuthUser.current();
        rateLimiter.hit("chat:" + me.id(), 10, Duration.ofSeconds(30));
        boolean exists = jdbc.sql("SELECT count(*) FROM chat_rooms WHERE id = ?").param(roomId).query(Long.class).single() > 0;
        if (!exists) {
            throw new Exceptions.NotFoundException("Chat room");
        }
        MessageView msg = jdbc.sql("""
                INSERT INTO chat_messages (room_id, user_id, message) VALUES (?, ?, ?)
                RETURNING id, room_id, ?::text AS username, message, created_at""")
                .params(roomId, me.id(), req.message().strip(), me.username())
                .query(ChatController::map).single();
        ws.publish("chat:" + roomId, "CHAT_MESSAGE", msg);
        return msg;
    }

    private static MessageView map(java.sql.ResultSet rs, int i) throws java.sql.SQLException {
        return new MessageView(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class), rs.getString(3),
                rs.getString(4), rs.getTimestamp(5).toInstant());
    }
}
