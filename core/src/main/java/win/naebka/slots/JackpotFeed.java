package win.naebka.slots;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import win.naebka.common.Money;
import win.naebka.slots.JackpotService.JackpotWinView;
import win.naebka.slots.JackpotService.Pool;
import win.naebka.ws.WsHub;

/**
 * Pushes the jackpot to everyone watching it, on the public {@value JackpotService#TOPIC} topic:
 * <ul>
 *   <li>{@code JACKPOT {gameId, amount, generation}}: the pool, at most twice a second however many people spin, and
 *       only when it changed. Each tick carries the latest pool that committed on this instance.</li>
 *   <li>{@code JACKPOT_WON {gameId, amount, generation, lastWin}}: right after a hit commits, with the new pool and the
 *       win (amount, the pool's generation, the winner's masked name, when).</li>
 * </ul>
 * A pool is newer than another if it has a later generation, or the same one with more in it (a pool only grows until
 * it is won), so ticks that arrive late, or from another instance, can never make the amount go backwards.
 */
@Component
public class JackpotFeed {
    private final WsHub ws;
    private final Map<UUID, Pool> latest = new ConcurrentHashMap<>();
    private final Map<UUID, Pool> published = new ConcurrentHashMap<>();

    public JackpotFeed(WsHub ws) {
        this.ws = ws;
    }

    /** A pool state that has just been committed. */
    public void offer(Pool pool) {
        latest.merge(pool.gameId(), pool, JackpotFeed::newer);
    }

    static Pool newer(Pool a, Pool b) {
        if (a.generation() != b.generation()) {
            return a.generation() > b.generation() ? a : b;
        }
        return a.amount() >= b.amount() ? a : b;
    }

    @Scheduled(fixedDelay = 500, initialDelay = 500)
    public void flush() {
        latest.forEach((game, pool) -> {
            if (!pool.equals(published.get(game))) {
                published.put(game, pool);
                ws.publish(JackpotService.TOPIC, "JACKPOT", tick(pool));
            }
        });
    }

    /** A hit. Called inside the spin's transaction: WsHub holds the message until it commits. */
    public void announce(Pool next, JackpotWinView win) {
        Map<String, Object> data = tick(next);
        data.put("lastWin", win);
        ws.publish(JackpotService.TOPIC, "JACKPOT_WON", data);
    }

    static Map<String, Object> tick(Pool pool) {
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("gameId", pool.gameId());
        data.put("amount", Money.toTokens(pool.amount()));
        data.put("generation", pool.generation());
        return data;
    }
}
