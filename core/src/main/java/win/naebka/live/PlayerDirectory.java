package win.naebka.live;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;
import win.naebka.common.Json;

/**
 * Steam names, avatars and rank badges of Deadlock players, as the watcher cached them in Redis
 * ({@code naebka:pname:{id}}, {@code naebka:prank:{id}}; see live/naebka_live/directory.py).
 */
@Component
public class PlayerDirectory {
    private final StringRedisTemplate redis;

    public PlayerDirectory(StringRedisTemplate redis) {
        this.redis = redis;
    }

    /** {@code players}: [{account_id, team, hero_id}] → the same with name, avatar and badge added where known. */
    public List<Map<String, Object>> enrich(JsonNode players) {
        List<Map<String, Object>> out = new ArrayList<>();
        if (players == null || !players.isArray() || players.isEmpty()) {
            return out;
        }
        List<String> keys = new ArrayList<>();
        for (JsonNode p : players) {
            long id = p.path("account_id").asLong();
            keys.add("naebka:pname:" + id);
            keys.add("naebka:prank:" + id);
        }
        List<String> values;
        try {
            values = redis.opsForValue().multiGet(keys);
        } catch (RuntimeException e) {
            values = null; // the names are decoration: the roster still shows heroes
        }
        Map<String, JsonNode> cached = new HashMap<>();
        for (int i = 0; values != null && i < keys.size(); i++) {
            String v = values.get(i);
            if (v != null) {
                try {
                    cached.put(keys.get(i), Json.read(v));
                } catch (RuntimeException ignored) {
                    // a malformed cache entry is the same as a missing one
                }
            }
        }
        for (JsonNode p : players) {
            long id = p.path("account_id").asLong();
            JsonNode name = cached.get("naebka:pname:" + id);
            JsonNode rank = cached.get("naebka:prank:" + id);
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("account_id", id);
            row.put("team", p.path("team").asInt());
            row.put("hero_id", p.path("hero_id").asInt());
            row.put("name", name == null || name.path("name").isNull() ? null : name.path("name").asText(null));
            row.put("avatar", name == null || name.path("avatar").isNull() ? null : name.path("avatar").asText(null));
            int badge = rank == null ? 0 : rank.path("badge").asInt(0);
            row.put("badge", badge > 0 ? badge : null);
            out.add(row);
        }
        return out;
    }
}
