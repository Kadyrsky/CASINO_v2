package win.naebka.common;

import java.time.Duration;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;

/** Fixed-window rate limiter on Redis, shared by all core instances (Risk #2, #9). */
@Component
public class RateLimiter {
    private final StringRedisTemplate redis;

    public RateLimiter(StringRedisTemplate redis) {
        this.redis = redis;
    }

    /** Counts one hit; throws RATE_LIMITED when more than {@code max} hits fall into the window. */
    public void hit(String key, int max, Duration window) {
        String k = "rl:" + key;
        Long count = redis.opsForValue().increment(k);
        if (count != null && count == 1) {
            redis.expire(k, window);
        }
        if (count != null && count > max) {
            throw new Exceptions.DomainException(ErrorCode.RATE_LIMITED, "Too many requests, slow down");
        }
    }
}
