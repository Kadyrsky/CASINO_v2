package win.naebka.live;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.time.Duration;
import java.util.UUID;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.http.CacheControl;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;
import win.naebka.auth.AuthUser;
import win.naebka.common.Exceptions;
import win.naebka.common.Json;

/**
 * Live matches page: every match in the in-game Watch tab with names, ranks and heroes (written to Redis by the
 * watcher, live/naebka_live/directory.py), the assets to draw them, and whether the caller may open a match's
 * realtime map. Public, except the map itself (WebSocket topic {@code watch:{id}}, see {@link LiveViewPolicy}).
 */
@RestController
public class LiveDirectoryController {
    private final StringRedisTemplate redis;
    private final JdbcClient jdbc;
    private final LiveViewPolicy policy;

    public LiveDirectoryController(StringRedisTemplate redis, JdbcClient jdbc, LiveViewPolicy policy) {
        this.redis = redis;
        this.jdbc = jdbc;
        this.policy = policy;
    }

    private ObjectNode directory() {
        String json = redis.opsForValue().get("live:directory");
        if (json != null) {
            JsonNode node = Json.read(json);
            if (node instanceof ObjectNode object) {
                return object;
            }
        }
        ObjectNode empty = JsonNodeFactory.instance.objectNode();
        empty.putNull("updated_at");
        empty.put("total", 0);
        empty.putArray("rank_spread");
        empty.putArray("matches");
        return empty;
    }

    /** Deadlock match id → our match id, for the matches you can bet on. */
    private ObjectNode bettable() {
        ObjectNode out = JsonNodeFactory.instance.objectNode();
        jdbc.sql("""
                SELECT m.external_id, m.id FROM matches m JOIN games g ON g.id = m.game_id
                WHERE g.code = 'deadlock' AND m.status IN ('LIVE', 'STALE')""")
                .query((rs, i) -> out.put(rs.getString(1), rs.getObject(2, UUID.class).toString()))
                .list();
        return out;
    }

    @GetMapping("/api/live/directory")
    public JsonNode list() {
        ObjectNode d = directory();
        d.set("bettable", bettable());
        return d;
    }

    @GetMapping(value = "/api/live/assets", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<String> assets() {
        String json = redis.opsForValue().get("live:assets");
        if (json == null) {
            throw new Exceptions.NotFoundException("Live assets (the watcher loads them on start)");
        }
        return ResponseEntity.ok().cacheControl(CacheControl.maxAge(Duration.ofHours(1)).cachePublic()).body(json);
    }

    /** One live match: its directory entry, our match id if it can be bet on, and whether the caller may watch it. */
    @GetMapping("/api/live/matches/{externalId}")
    public JsonNode one(@PathVariable String externalId) {
        if (!externalId.matches("[0-9]{1,20}")) {
            throw new Exceptions.NotFoundException("Live match");
        }
        ObjectNode out = JsonNodeFactory.instance.objectNode();
        JsonNode entry = null;
        for (JsonNode m : directory().path("matches")) {
            if (externalId.equals(m.path("match_id").asText())) {
                entry = m;
                break;
            }
        }
        JsonNode bettable = bettable().get(externalId);
        if (entry == null && bettable == null && redis.opsForValue().get("live:frame:" + externalId) == null) {
            throw new Exceptions.NotFoundException("Live match");
        }
        out.set("match", entry);
        out.put("bettableMatchId", bettable == null ? null : bettable.asText());
        AuthUser user = AuthUser.currentOrNull();
        LiveViewPolicy.Decision d = policy.check(user == null ? null : user.id(), externalId);
        ObjectNode watch = out.putObject("watch");
        watch.put("allowed", d.allowed());
        watch.put("reason", d.reason().name());
        watch.put("minStakeTokens", d.minStakeTokens());
        watch.put("stakedTokens", d.stakedTokens());
        return out;
    }
}
