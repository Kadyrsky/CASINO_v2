package win.naebka.poker;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;
import win.naebka.common.Cursor;
import win.naebka.common.ErrorCode;
import win.naebka.common.Exceptions;
import win.naebka.common.Exceptions.DomainException;
import win.naebka.common.Money;
import win.naebka.config.NaebkaProperties;
import win.naebka.wallet.LedgerSource;
import win.naebka.wallet.ResponsibleGamingService;
import win.naebka.wallet.TxType;
import win.naebka.wallet.WalletService;
import win.naebka.ws.WsHub;

/**
 * Poker money, persistence and broadcasting. Chips move wallet → seat stack on sitting down (POKER_BUY_IN)
 * and back on leaving (POKER_CASH_OUT); during play they live in poker_seats.stack, updated after every
 * hand together with poker_hands / poker_hand_players.
 */
@Service
public class PokerService implements PokerEventListener {
    private static final Logger log = LoggerFactory.getLogger(PokerService.class);

    private final JdbcClient jdbc;
    private final TransactionTemplate tx;
    private final WalletService wallets;
    private final ResponsibleGamingService rg;
    private final PokerTableManager manager;
    private final WsHub ws;
    private final NaebkaProperties props;

    public PokerService(JdbcClient jdbc, TransactionTemplate tx, WalletService wallets, ResponsibleGamingService rg,
                        PokerTableManager manager, WsHub ws, NaebkaProperties props) {
        this.jdbc = jdbc;
        this.tx = tx;
        this.wallets = wallets;
        this.rg = rg;
        this.manager = manager;
        this.ws = ws;
        this.props = props;
        manager.setBroadcaster(this::broadcast);
    }

    public static String topic(UUID tableId) {
        return "poker:" + tableId;
    }

    /**
     * Crash recovery: in-memory tables do not survive a restart, so every chip still on a seat goes back
     * to its owner's wallet before the tables open again.
     */
    @EventListener(ApplicationReadyEvent.class)
    public void loadTables() {
        record SeatRow(UUID id, UUID userId, long stack) {}
        List<SeatRow> orphaned = jdbc.sql("SELECT id, user_id, stack FROM poker_seats")
                .query((rs, i) -> new SeatRow(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class), rs.getLong(3)))
                .list();
        for (SeatRow s : orphaned) {
            tx.executeWithoutResult(st -> {
                if (s.stack() > 0) {
                    wallets.credit(wallets.walletIdOf(s.userId()), s.stack(), TxType.POKER_CASH_OUT, LedgerSource.NONE,
                            "poker-cashout:" + s.id());
                }
                jdbc.sql("DELETE FROM poker_seats WHERE id = ?").param(s.id()).update();
            });
        }
        if (!orphaned.isEmpty()) {
            log.warn("Returned {} poker seat stacks to wallets after restart", orphaned.size());
        }
        jdbc.sql("SELECT id, name, max_seats, small_blind, big_blind FROM poker_tables WHERE status = 'OPEN'")
                .query((rs, i) -> new PokerTable(rs.getObject(1, UUID.class), rs.getString(2), rs.getInt(3), rs.getLong(4),
                        rs.getLong(5), props.poker().rakePercent(), props.poker().rakeCapBigBlinds(), new Deck()))
                .list()
                .forEach(t -> {
                    t.addListener(this);
                    manager.register(t);
                });
    }

    // ------------------------------------------------------------------ seating & money

    public record TableInfo(UUID id, String name, BigDecimal smallBlind, BigDecimal bigBlind, int maxSeats, int seated,
                            boolean handInProgress, BigDecimal minBuyIn, BigDecimal maxBuyIn) {}

    public List<TableInfo> tables() {
        return manager.tables().stream()
                .sorted(java.util.Comparator.comparingLong(PokerTable::getBigBlind))
                .map(t -> new TableInfo(t.getTableId(), t.getName(), Money.toTokens(t.getSmallBlind()),
                        Money.toTokens(t.getBigBlind()), t.getMaxSeats(), t.seatedCount(), t.isHandInProgress(),
                        Money.toTokens(t.getBigBlind() * props.poker().minBuyInBigBlinds()),
                        Money.toTokens(t.getBigBlind() * props.poker().maxBuyInBigBlinds())))
                .toList();
    }

    public Map<String, Object> sit(UUID userId, String username, UUID tableId, int seatNo, long buyIn, String ip) {
        rg.assertCanWager(userId, buyIn);
        return manager.call(tableId, table -> {
            long min = table.getBigBlind() * props.poker().minBuyInBigBlinds();
            long max = table.getBigBlind() * props.poker().maxBuyInBigBlinds();
            if (buyIn < min || buyIn > max) {
                throw new Exceptions.InvalidBetAmountException(ErrorCode.INVALID_AMOUNT,
                        "Buy-in must be between " + Money.toTokens(min) + " and " + Money.toTokens(max),
                        Map.of("minBuyIn", Money.toTokens(min), "maxBuyIn", Money.toTokens(max)));
            }
            if (table.findPlayer(userId).isPresent()) {
                throw new DomainException(ErrorCode.ALREADY_SEATED, "You are already seated at this table");
            }
            if (table.seatedCount() >= table.getMaxSeats()) {
                throw new Exceptions.TableFullException();
            }
            if (seatNo < 0 || seatNo >= table.getMaxSeats()
                    || table.seatedPlayers().stream().anyMatch(p -> p.getSeatIndex() == seatNo)) {
                throw new DomainException(ErrorCode.SEAT_TAKEN, "Seat " + seatNo + " is not available");
            }
            // Anti-collusion: players from the same IP may not share a table (LLD §2.1).
            if (props.poker().blockSameIp() && table.seatedPlayers().stream().anyMatch(p -> p.getIp().equals(ip))) {
                throw new DomainException(ErrorCode.SAME_IP_AT_TABLE,
                        "Another player from your network is already at this table");
            }
            UUID seatRowId = tx.execute(st -> {
                UUID id = jdbc.sql("""
                        INSERT INTO poker_seats (table_id, user_id, seat_no, stack) VALUES (?, ?, ?, ?) RETURNING id""")
                        .params(tableId, userId, seatNo, buyIn).query(UUID.class).single();
                wallets.debit(wallets.walletIdOf(userId), buyIn, TxType.POKER_BUY_IN, LedgerSource.NONE, "poker-buyin:" + id);
                return id;
            });
            Player player = new Player(userId, username, seatNo, buyIn, ip, seatRowId);
            table.addPlayer(player, seatNo);
            return table.privateState(userId);
        });
    }

    public Map<String, Object> leave(UUID userId, UUID tableId) {
        return manager.call(tableId, table -> {
            if (table.findPlayer(userId).isEmpty()) {
                throw new DomainException(ErrorCode.NOT_SEATED, "You are not seated at this table");
            }
            var removed = table.removePlayer(userId);
            removed.ifPresent(this::cashOut);
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("left", removed.isPresent());
            out.put("message", removed.isPresent() ? "Chips returned to your wallet"
                    : "You folded; you will leave the table when this hand ends");
            removed.ifPresent(p -> out.put("cashedOut", Money.toTokens(p.getChipStack())));
            return out;
        });
    }

    private void cashOut(Player p) {
        tx.executeWithoutResult(st -> {
            jdbc.sql("DELETE FROM poker_seats WHERE id = ?").param(p.getSeatRowId()).update();
            if (p.getChipStack() > 0) {
                wallets.credit(wallets.walletIdOf(p.getId()), p.getChipStack(), TxType.POKER_CASH_OUT, LedgerSource.NONE,
                        "poker-cashout:" + p.getSeatRowId());
            }
        });
        ws.publishToUser(p.getId(), "POKER_LEFT", Map.of("cashedOut", Money.toTokens(p.getChipStack())));
    }

    public void act(UUID userId, UUID tableId, PlayerAction action) {
        manager.call(tableId, table -> {
            table.findPlayer(userId).ifPresent(p -> p.setConsecutiveTimeouts(0));
            return table.applyAction(userId, action);
        });
    }

    public void setSittingOut(UUID userId, UUID tableId, boolean sittingOut) {
        manager.call(tableId, table -> {
            Player p = table.findPlayer(userId)
                    .orElseThrow(() -> new DomainException(ErrorCode.NOT_SEATED, "You are not seated at this table"));
            p.setSittingOut(sittingOut);
            p.setConsecutiveTimeouts(0);
            manager.markDirty(tableId);
            return null;
        });
    }

    /** Full state for one viewer: public view plus their private cards and legal actions (SYNC_GAME_STATE). */
    public Map<String, Object> snapshot(UUID tableId, UUID viewerId) {
        return manager.call(tableId, table -> {
            Map<String, Object> s = new LinkedHashMap<>();
            Map<String, Object> pub = table.publicState();
            pub.put("turnDeadline", manager.turnDeadline(tableId));
            s.put("table", pub);
            if (viewerId != null) {
                s.put("me", table.privateState(viewerId));
            }
            return s;
        });
    }

    // ------------------------------------------------------------------ connectivity

    public void userConnected(UUID userId) {
        forEachSeat(userId, (table, p) -> {
            if (!p.isConnected()) {
                p.setConnected(true);
                p.setSittingOut(false);
                manager.markDirty(table.getTableId());
            }
        });
    }

    /**
     * LLD WebSocketDisconnectionException (poker): the player keeps the seat for the reconnect grace period;
     * after it they are sat out, and on their turn the auto-action policy (check, otherwise fold) applies.
     */
    public void userDisconnected(UUID userId) {
        forEachSeat(userId, (table, p) -> {
            p.setConnected(false);
            manager.markDirty(table.getTableId());
        });
        java.util.concurrent.CompletableFuture.delayedExecutor(props.poker().reconnectGraceSeconds(),
                java.util.concurrent.TimeUnit.SECONDS).execute(() -> forEachSeat(userId, (table, p) -> {
            if (!p.isConnected()) {
                p.setSittingOut(true);
                manager.markDirty(table.getTableId());
                if (table.isTurnOf(userId)) {
                    table.handleTimeout(userId);
                }
            }
        }));
    }

    private void forEachSeat(UUID userId, java.util.function.BiConsumer<PokerTable, Player> fn) {
        for (PokerTable t : manager.tables()) {
            try {
                manager.call(t.getTableId(), table -> {
                    table.findPlayer(userId).ifPresent(p -> fn.accept(table, p));
                    return null;
                });
            } catch (RuntimeException e) {
                log.warn("Poker connectivity update failed: {}", e.getMessage());
            }
        }
    }

    // ------------------------------------------------------------------ events

    @Override
    public void onGameStateChanged(PokerTable table) {
        manager.markDirty(table.getTableId());
    }

    @Override
    public void onPlayerActed(PokerTable table, UUID playerId, PlayerAction action) {
        String username = table.findPlayer(playerId).map(Player::getUsername).orElse("?");
        ws.publish(topic(table.getTableId()), "POKER_ACTION", Map.of("userId", playerId, "username", username,
                "action", action.type(), "amount", action.amount()));
    }

    @Override
    public void onHandCompleted(PokerTable table, PokerTable.HandResult result) {
        try {
            tx.executeWithoutResult(st -> persistHand(table, result));
        } catch (RuntimeException e) {
            log.error("Failed to persist poker hand {} on {}", result.handNumber(), table.getName(), e);
        }
        ws.publish(topic(table.getTableId()), "POKER_HAND_COMPLETE", result);
        table.collectLeavers().forEach(this::cashOut);
    }

    private void persistHand(PokerTable table, PokerTable.HandResult r) {
        UUID handId = jdbc.sql("""
                INSERT INTO poker_hands (table_id, rake, board, started_at, ended_at) VALUES (?, ?, ?, ?, ?) RETURNING id""")
                .params(table.getTableId(), r.rake(), String.join(" ", r.board()), java.sql.Timestamp.from(r.startedAt()),
                        java.sql.Timestamp.from(r.endedAt()))
                .query(UUID.class).single();
        r.contributions().forEach((userId, bet) -> {
            var shown = r.shown().get(userId);
            jdbc.sql("""
                    INSERT INTO poker_hand_players (hand_id, user_id, bet_total, win_amount, hole_cards, hand_rank)
                    VALUES (?, ?, ?, ?, ?, ?)""")
                    .params(handId, userId, bet, r.winnings().getOrDefault(userId, 0L),
                            shown == null ? null : String.join(" ", shown.cards()), shown == null ? null : shown.handRank())
                    .update();
        });
        for (Player p : table.seatedPlayers()) {
            jdbc.sql("UPDATE poker_seats SET stack = ? WHERE id = ?").params(p.getChipStack(), p.getSeatRowId()).update();
        }
    }

    private void broadcast(PokerTableManager.TableSnapshot snap) {
        PokerTable table = snap.table();
        Map<String, Object> pub = table.publicState();
        pub.put("turnDeadline", snap.turnDeadline());
        ws.publish(topic(table.getTableId()), "POKER_STATE", pub);
        for (Player p : table.seatedPlayers()) {
            ws.publishToUser(p.getId(), "POKER_PRIVATE", table.privateState(p.getId()));
        }
    }

    // ------------------------------------------------------------------ history

    public record HandHistoryView(UUID handId, String tableName, String board, BigDecimal betTotal, BigDecimal winAmount,
                                  String holeCards, String handRank, Instant startedAt) {}

    public Cursor.Page<HandHistoryView> history(UUID userId, Cursor cursor, int limit) {
        String where = cursor == null ? "" : "AND (h.started_at, h.id) < (:at, :cid)";
        var spec = jdbc.sql("""
                SELECT h.id, t.name, h.board, p.bet_total, p.win_amount, p.hole_cards, p.hand_rank, h.started_at
                FROM poker_hand_players p JOIN poker_hands h ON h.id = p.hand_id JOIN poker_tables t ON t.id = h.table_id
                WHERE p.user_id = :user %s ORDER BY h.started_at DESC, h.id DESC LIMIT :limit""".formatted(where))
                .param("user", userId).param("limit", limit + 1);
        if (cursor != null) {
            spec = spec.param("at", java.sql.Timestamp.from(cursor.at())).param("cid", cursor.id());
        }
        var rows = spec.query((rs, i) -> new HandHistoryView(rs.getObject(1, UUID.class), rs.getString(2), rs.getString(3),
                Money.toTokens(rs.getLong(4)), Money.toTokens(rs.getLong(5)), rs.getString(6), rs.getString(7),
                rs.getTimestamp(8).toInstant())).list();
        return Cursor.Page.of(rows, limit, h -> new Cursor(h.startedAt(), h.handId()));
    }
}
