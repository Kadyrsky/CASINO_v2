package win.naebka.poker;

import java.time.Instant;
import java.util.Collection;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.function.Consumer;
import java.util.function.Function;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import win.naebka.common.Exceptions;
import win.naebka.config.NaebkaProperties;

/**
 * Runs every table as an actor: one single-threaded executor per table, so commands, timers and the
 * automatic deal of the next hand never interleave. Also owns the turn timer (auto check/fold on expiry).
 */
@Component
public class PokerTableManager {
    private static final Logger log = LoggerFactory.getLogger(PokerTableManager.class);
    private static final long NEXT_HAND_DELAY_MS = 4_000;

    private final Map<UUID, Actor> actors = new ConcurrentHashMap<>();
    private final NaebkaProperties props;
    private Consumer<PokerTableManager.TableSnapshot> broadcaster = s -> {};

    public PokerTableManager(NaebkaProperties props) {
        this.props = props;
    }

    /** Called after every change with the table and its current turn deadline (null when nobody is to act). */
    public record TableSnapshot(PokerTable table, Instant turnDeadline) {}

    private static final class Actor {
        final PokerTable table;
        final ScheduledExecutorService exec;
        ScheduledFuture<?> turnTimer;
        long timerSeq = -1;
        Instant turnDeadline;
        ScheduledFuture<?> nextHand;
        boolean dirty;

        Actor(PokerTable table) {
            this.table = table;
            this.exec = Executors.newSingleThreadScheduledExecutor(r -> new Thread(r, "poker-" + table.getName()));
        }
    }

    public void setBroadcaster(Consumer<TableSnapshot> broadcaster) {
        this.broadcaster = broadcaster;
    }

    public void register(PokerTable table) {
        actors.put(table.getTableId(), new Actor(table));
    }

    public Collection<PokerTable> tables() {
        return actors.values().stream().map(a -> a.table).toList();
    }

    public void markDirty(UUID tableId) {
        Actor a = actors.get(tableId);
        if (a != null) {
            a.dirty = true;
        }
    }

    /** Runs {@code fn} on the table's actor thread and waits for the result (exceptions are rethrown). */
    public <T> T call(UUID tableId, Function<PokerTable, T> fn) {
        Actor actor = actors.get(tableId);
        if (actor == null) {
            throw new Exceptions.NotFoundException("Poker table");
        }
        Future<T> f = actor.exec.submit(() -> {
            try {
                return fn.apply(actor.table);
            } finally {
                afterChange(actor);
            }
        });
        try {
            return f.get(10, TimeUnit.SECONDS);
        } catch (ExecutionException e) {
            if (e.getCause() instanceof RuntimeException re) {
                throw re;
            }
            throw new IllegalStateException(e.getCause());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException(e);
        } catch (TimeoutException e) {
            throw new Exceptions.DatabaseTimeoutException();
        }
    }

    public Instant turnDeadline(UUID tableId) {
        Actor a = actors.get(tableId);
        return a == null ? null : a.turnDeadline;
    }

    /** Reschedules the turn timer / next-hand deal and broadcasts if anything changed. Actor thread only. */
    private void afterChange(Actor a) {
        PokerTable t = a.table;
        var current = t.currentPlayer();
        if (current.isPresent()) {
            if (a.timerSeq != t.getActionSeq()) {
                cancel(a.turnTimer);
                long seq = t.getActionSeq();
                UUID playerId = current.get().getId();
                // Disconnected or sitting-out players are auto-acted quickly instead of stalling the table.
                long delayMs = current.get().isConnected() && !current.get().isSittingOut()
                        ? props.poker().turnTimeoutSeconds() * 1000L : 2_000L;
                a.timerSeq = seq;
                a.turnDeadline = Instant.now().plusMillis(delayMs);
                a.turnTimer = a.exec.schedule(() -> {
                    try {
                        if (t.getActionSeq() == seq) {
                            t.handleTimeout(playerId);
                        }
                    } catch (RuntimeException e) {
                        log.error("Turn timeout failed on {}", t.getName(), e);
                    } finally {
                        afterChange(a);
                    }
                }, delayMs, TimeUnit.MILLISECONDS);
                a.dirty = true;
            }
        } else {
            cancel(a.turnTimer);
            a.turnTimer = null;
            a.timerSeq = -1;
            if (a.turnDeadline != null) {
                a.turnDeadline = null;
                a.dirty = true;
            }
            if (t.canStartHand() && (a.nextHand == null || a.nextHand.isDone())) {
                a.nextHand = a.exec.schedule(() -> {
                    try {
                        if (t.canStartHand()) {
                            t.startHand();
                        }
                    } catch (RuntimeException e) {
                        log.error("Could not start hand on {}", t.getName(), e);
                    } finally {
                        afterChange(a);
                    }
                }, NEXT_HAND_DELAY_MS, TimeUnit.MILLISECONDS);
            }
        }
        if (a.dirty) {
            a.dirty = false;
            try {
                broadcaster.accept(new TableSnapshot(t, a.turnDeadline));
            } catch (RuntimeException e) {
                log.warn("Poker broadcast failed: {}", e.getMessage());
            }
        }
    }

    private static void cancel(ScheduledFuture<?> f) {
        if (f != null) {
            f.cancel(false);
        }
    }

    @PreDestroy
    void shutdown() {
        actors.values().forEach(a -> a.exec.shutdownNow());
    }
}
