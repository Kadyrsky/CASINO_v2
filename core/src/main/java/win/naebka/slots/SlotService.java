package win.naebka.slots;

import com.fasterxml.jackson.databind.JsonNode;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.PessimisticLockingFailureException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import win.naebka.common.Cursor;
import win.naebka.common.ErrorCode;
import win.naebka.common.Exceptions;
import win.naebka.common.Exceptions.GameStateMismatchException;
import win.naebka.common.Json;
import win.naebka.common.Money;
import win.naebka.wallet.LedgerSource;
import win.naebka.wallet.ResponsibleGamingService;
import win.naebka.wallet.TxType;
import win.naebka.wallet.WalletService;
import win.naebka.ws.WsHub;

/**
 * Slot orchestration: per-player state machine (IDLE / FREE_SPINNING / BONUS_GAME), provably-fair seeds,
 * money through the ledger, jackpot pool. Every spin is one transaction — stake debit, round row, win credit
 * and jackpot contribution commit together or not at all, so a disconnect mid-spin never loses funds
 * (LLD: WebSocketDisconnectionException, slot engine).
 */
@Service
public class SlotService {
    private static final Logger log = LoggerFactory.getLogger(SlotService.class);
    private static final Logger security = LoggerFactory.getLogger("SECURITY_CRITICAL_LOG");
    public static final long MIN_BET_PER_LINE = 1;      // 0.01 NTK
    public static final long MAX_BET_PER_LINE = 1_000;  // 10.00 NTK

    private final JdbcClient jdbc;
    private final WalletService wallets;
    private final ResponsibleGamingService rg;
    private final WsHub ws;

    public SlotService(JdbcClient jdbc, WalletService wallets, ResponsibleGamingService rg, WsHub ws) {
        this.jdbc = jdbc;
        this.wallets = wallets;
        this.rg = rg;
        this.ws = ws;
    }

    public record LineView(int paylineId, String symbol, int count, BigDecimal win, int[] positions) {}

    public record BonusView(int boxes, List<Map<String, Object>> opened, int remainingPicks, BigDecimal totalWin) {}

    public record SpinResult(UUID spinId, String[][] grid, BigDecimal totalBet, BigDecimal totalWin,
                             List<LineView> winningLines, int scatterCount, int freeSpinsAwarded,
                             int freeSpinsRemaining, boolean isBonusGameTriggered, BigDecimal jackpotWin,
                             SlotState nextState, String hmacHash, String serverSeedHash, String clientSeed, long nonce,
                             BigDecimal balance, boolean freeSpin) {}

    public record StateView(UUID gameId, SlotState state, int freeSpinsRemaining, BigDecimal freeSpinBetPerLine,
                            BonusView bonus, BigDecimal jackpot, Map<String, Object> fairness, SpinResult lastSpin) {}

    record Session(SlotState state, int freeSpinsRemaining, long freeSpinBet, JsonNode bonusState, UUID lastRoundId) {}

    record Seed(UUID id, String serverSeed, String serverSeedHash, String clientSeed, long nonce) {}

    public UUID defaultGameId() {
        return jdbc.sql("SELECT id FROM slot_games WHERE name = 'Soul Reels'").query(UUID.class).single();
    }

    // ------------------------------------------------------------------ spins

    @Transactional
    public SpinResult spin(UUID userId, long betPerLine) {
        if (betPerLine < MIN_BET_PER_LINE || betPerLine > MAX_BET_PER_LINE) {
            throw new Exceptions.InvalidBetAmountException(ErrorCode.INVALID_AMOUNT,
                    "Bet per line must be between 0.01 and 10.00", Map.of("min", "0.01", "max", "10.00"));
        }
        long totalBet = betPerLine * SlotMachine.paylineCount();
        rg.assertCanWager(userId, totalBet);
        UUID gameId = defaultGameId();
        Session session = lockSession(userId, gameId);
        if (session.state() == SlotState.BONUS_GAME) {
            throw new GameStateMismatchException("Finish the bonus game first");
        }
        if (session.state() == SlotState.FREE_SPINNING) {
            throw new GameStateMismatchException("You have free spins to play");
        }
        return play(userId, gameId, session, betPerLine, false);
    }

    @Transactional
    public SpinResult executeFreeSpin(UUID userId) {
        UUID gameId = defaultGameId();
        Session session = lockSession(userId, gameId);
        if (session.state() != SlotState.FREE_SPINNING || session.freeSpinsRemaining() <= 0) {
            throw new GameStateMismatchException("No free spins available");
        }
        return play(userId, gameId, session, session.freeSpinBet(), true);
    }

    private SpinResult play(UUID userId, UUID gameId, Session session, long betPerLine, boolean free) {
        long totalBet = betPerLine * SlotMachine.paylineCount();
        UUID walletId = wallets.walletIdOf(userId);
        Seed seed = nextNonce(userId);
        ProvablyFairRNG rng = new ProvablyFairRNG(seed.serverSeed(), seed.clientSeed(), seed.nonce());
        SlotMachine.Outcome outcome = SlotMachine.spin(rng, betPerLine);

        // RNGVerificationFailedException policy: recompute independently before any money moves.
        if (!ProvablyFairRNG.verifyResult(seed.serverSeed(), seed.clientSeed(), seed.nonce(), outcome.grid(),
                SlotMachine.ROWS, SlotMachine.REELS)) {
            security.error("RNG verification failed for user {} seed {} nonce {}", userId, seed.id(), seed.nonce());
            throw new Exceptions.RNGVerificationFailedException("Spin aborted and stake refunded: RNG verification failed");
        }

        SpinPayout payout = outcome.payout();
        long jackpotWin = 0;
        if (!free) {
            jdbc.sql("""
                    UPDATE jackpot_pools SET amount = amount + (? * contribution_bp) / 10000, updated_at = now()
                    WHERE game_id = ?""").params(totalBet, gameId).update();
        }
        if (payout.jackpotHit()) {
            jackpotWin = jdbc.sql("""
                    UPDATE jackpot_pools p SET amount = p.seed_amount, updated_at = now()
                    FROM jackpot_pools old WHERE p.game_id = old.game_id AND p.game_id = ?
                    RETURNING old.amount""").param(gameId).query(Long.class).single();
        }

        int freeAfter = Math.max(0, session.freeSpinsRemaining() - (free ? 1 : 0)) + payout.freeSpinsAwarded();
        PickAndClickBonus bonus = null;
        if (payout.bonusTriggered()) {
            double[] f = rng.floats(SlotMachine.COLUMNS + PickAndClickBonus.REWARD_MULTIPLIERS.length);
            bonus = PickAndClickBonus.create(userId, totalBet, Arrays.copyOfRange(f, SlotMachine.COLUMNS, f.length));
        }
        SlotState next = bonus != null ? SlotState.BONUS_GAME : freeAfter > 0 ? SlotState.FREE_SPINNING : SlotState.IDLE;

        Map<String, Object> resultData = new LinkedHashMap<>();
        resultData.put("type", free ? "free_spin" : "spin");
        resultData.put("stops", outcome.stops());
        resultData.put("grid", gridIds(outcome.grid()));
        resultData.put("betPerLine", betPerLine);
        resultData.put("lines", payout.winningLines().stream().map(l -> Map.of("paylineId", l.paylineId(),
                "symbol", l.winningSymbol().id(), "count", l.symbolCount(), "multiplier", l.lineMultiplier())).toList());
        resultData.put("scatterCount", payout.scatterCount());
        resultData.put("freeSpinsAwarded", payout.freeSpinsAwarded());
        resultData.put("bonusTriggered", payout.bonusTriggered());
        resultData.put("jackpotWin", jackpotWin);
        resultData.put("seedId", seed.id());
        resultData.put("serverSeedHash", seed.serverSeedHash());
        resultData.put("clientSeed", seed.clientSeed());
        resultData.put("nonce", seed.nonce());
        resultData.put("hmacHash", rng.hmacHash());

        long totalWin = payout.totalWin() + jackpotWin;
        UUID roundId = jdbc.sql("""
                INSERT INTO slot_rounds (game_id, wallet_id, bet_amount, win_amount, result_data)
                VALUES (?, ?, ?, ?, ?::jsonb) RETURNING id""")
                .params(gameId, walletId, free ? 0 : totalBet, totalWin, Json.write(resultData))
                .query(UUID.class).single();
        if (!free) {
            wallets.debit(walletId, totalBet, TxType.SLOT_BET, LedgerSource.slotRound(roundId), "slot-bet:" + roundId);
        }
        if (payout.totalWin() > 0) {
            wallets.credit(walletId, payout.totalWin(), TxType.SLOT_WIN, LedgerSource.slotRound(roundId), "slot-win:" + roundId);
        }
        if (jackpotWin > 0) {
            wallets.credit(walletId, jackpotWin, TxType.JACKPOT_WIN, LedgerSource.slotRound(roundId), "jackpot:" + roundId);
            ws.publish("lobby", "JACKPOT_WON", Map.of("amount", Money.toTokens(jackpotWin)));
            log.info("Jackpot of {} won by {}", jackpotWin, userId);
        }

        saveSession(userId, gameId, next, freeAfter, freeAfter > 0 ? betPerLine : 0,
                bonus == null ? null : bonusJson(bonus, totalBet), roundId);
        return toResult(roundId, resultData, outcome.grid(), free ? 0 : totalBet, totalWin, freeAfter, next, seed,
                wallets.walletOf(userId).balance(), free);
    }

    // ------------------------------------------------------------------ bonus game

    public record BonusPickResult(int choice, BigDecimal reward, BigDecimal totalBonusWin, int remainingPicks,
                                  boolean completed, List<BigDecimal> revealedBoard, SlotState nextState,
                                  BigDecimal balance) {}

    @Transactional
    public BonusPickResult playBonusTurn(UUID userId, int choice) {
        UUID gameId = defaultGameId();
        Session session = lockSession(userId, gameId);
        if (session.state() != SlotState.BONUS_GAME || session.bonusState() == null) {
            throw new GameStateMismatchException("No bonus game in progress");
        }
        JsonNode b = session.bonusState();
        List<Long> rewards = new ArrayList<>();
        b.path("rewards").forEach(n -> rewards.add(n.asLong()));
        List<Integer> picked = new ArrayList<>();
        b.path("picked").forEach(n -> picked.add(n.asInt()));
        PickAndClickBonus bonus = new PickAndClickBonus(userId, rewards, picked, b.path("remaining").asInt(),
                b.path("total").asLong());
        BonusGame.BonusTurnResult turn = bonus.playTurn(choice);

        SlotState next = SlotState.BONUS_GAME;
        List<BigDecimal> board = null;
        if (turn.completed()) {
            UUID walletId = wallets.walletIdOf(userId);
            Map<String, Object> resultData = Map.of("type", "bonus", "rewards", rewards, "picked", bonus.picked(),
                    "triggeredBy", session.lastRoundId() == null ? "" : session.lastRoundId().toString());
            UUID roundId = jdbc.sql("""
                    INSERT INTO slot_rounds (game_id, wallet_id, bet_amount, win_amount, result_data)
                    VALUES (?, ?, 0, ?, ?::jsonb) RETURNING id""")
                    .params(gameId, walletId, turn.totalBonusWin(), Json.write(resultData)).query(UUID.class).single();
            wallets.credit(walletId, turn.totalBonusWin(), TxType.SLOT_WIN, LedgerSource.slotRound(roundId),
                    "slot-bonus:" + roundId);
            next = session.freeSpinsRemaining() > 0 ? SlotState.FREE_SPINNING : SlotState.IDLE;
            saveSession(userId, gameId, next, session.freeSpinsRemaining(), session.freeSpinBet(), null, roundId);
            board = rewards.stream().map(Money::toTokens).toList();
        } else {
            saveSession(userId, gameId, next, session.freeSpinsRemaining(), session.freeSpinBet(),
                    bonusJson(bonus, b.path("totalBet").asLong()), session.lastRoundId());
        }
        return new BonusPickResult(choice, Money.toTokens(turn.reward()), Money.toTokens(turn.totalBonusWin()),
                turn.remainingAttempts(), turn.completed(), board, next, Money.toTokens(wallets.walletOf(userId).balance()));
    }

    private static String bonusJson(PickAndClickBonus bonus, long totalBet) {
        return Json.write(Map.of("rewards", bonus.hiddenRewards(), "picked", bonus.picked(),
                "remaining", bonus.isCompleted() ? 0 : PickAndClickBonus.PICKS - bonus.picked().size(),
                "total", bonus.totalBonusWin(), "totalBet", totalBet));
    }

    // ------------------------------------------------------------------ state

    /**
     * Locks the player's slot session. NOWAIT: if another spin of the same player is still running, this one
     * is rejected immediately (LLD: GameStateMismatchException) instead of queuing behind it.
     */
    private Session lockSession(UUID userId, UUID gameId) {
        jdbc.sql("""
                INSERT INTO slot_sessions (user_id, game_id, state) VALUES (?, ?, 'IDLE')
                ON CONFLICT (user_id, game_id) DO NOTHING""").params(userId, gameId).update();
        try {
            return jdbc.sql("""
                    SELECT state, free_spins_remaining, free_spin_bet, bonus_state::text, last_round_id
                    FROM slot_sessions WHERE user_id = ? AND game_id = ? FOR UPDATE NOWAIT""")
                    .params(userId, gameId)
                    .query((rs, i) -> new Session(SlotState.valueOf(rs.getString(1)), rs.getInt(2), rs.getLong(3),
                            rs.getString(4) == null ? null : Json.read(rs.getString(4)), rs.getObject(5, UUID.class)))
                    .single();
        } catch (PessimisticLockingFailureException e) {
            throw new GameStateMismatchException("A previous spin is still being processed");
        }
    }

    private void saveSession(UUID userId, UUID gameId, SlotState state, int freeSpins, long freeSpinBet, String bonusJson,
                             UUID lastRoundId) {
        jdbc.sql("""
                UPDATE slot_sessions SET state = ?, free_spins_remaining = ?, free_spin_bet = ?, bonus_state = ?::jsonb,
                       last_round_id = ?, updated_at = now()
                WHERE user_id = ? AND game_id = ?""")
                .params(state.name(), freeSpins, freeSpinBet, bonusJson, lastRoundId, userId, gameId).update();
    }

    /** Session state recovery after a reconnect: state, pending free spins / bonus, and the last spin. */
    public StateView state(UUID userId) {
        UUID gameId = defaultGameId();
        Optional<Session> s = jdbc.sql("""
                SELECT state, free_spins_remaining, free_spin_bet, bonus_state::text, last_round_id
                FROM slot_sessions WHERE user_id = ? AND game_id = ?""")
                .params(userId, gameId)
                .query((rs, i) -> new Session(SlotState.valueOf(rs.getString(1)), rs.getInt(2), rs.getLong(3),
                        rs.getString(4) == null ? null : Json.read(rs.getString(4)), rs.getObject(5, UUID.class)))
                .optional();
        Session session = s.orElse(new Session(SlotState.IDLE, 0, 0, null, null));
        BonusView bonus = null;
        if (session.bonusState() != null) {
            JsonNode b = session.bonusState();
            List<Map<String, Object>> opened = new ArrayList<>();
            b.path("picked").forEach(p -> opened.add(Map.of("box", p.asInt(),
                    "reward", Money.toTokens(b.path("rewards").get(p.asInt()).asLong()))));
            bonus = new BonusView(b.path("rewards").size(), opened, b.path("remaining").asInt(),
                    Money.toTokens(b.path("total").asLong()));
        }
        SpinResult last = session.lastRoundId() == null ? null : roundAsSpin(session.lastRoundId(), userId).orElse(null);
        Seed seed = activeSeed(userId);
        return new StateView(gameId, session.state(), session.freeSpinsRemaining(),
                Money.toTokens(session.freeSpinBet()), bonus, jackpot(),
                Map.of("serverSeedHash", seed.serverSeedHash(), "clientSeed", seed.clientSeed(), "nonce", seed.nonce()),
                last);
    }

    public BigDecimal jackpot() {
        return Money.toTokens(jdbc.sql("SELECT amount FROM jackpot_pools WHERE game_id = ?").param(defaultGameId())
                .query(Long.class).single());
    }

    private Optional<SpinResult> roundAsSpin(UUID roundId, UUID userId) {
        return jdbc.sql("""
                SELECT r.result_data::text, r.bet_amount, r.win_amount FROM slot_rounds r
                JOIN wallets w ON w.id = r.wallet_id WHERE r.id = ? AND w.user_id = ?""")
                .params(roundId, userId)
                .query((rs, i) -> {
                    JsonNode d = Json.read(rs.getString(1));
                    if (!d.has("grid")) {
                        return null; // bonus round, no grid to show
                    }
                    String[][] grid = Json.MAPPER.convertValue(d.path("grid"), String[][].class);
                    return new SpinResult(roundId, grid, Money.toTokens(rs.getLong(2)), Money.toTokens(rs.getLong(3)),
                            linesFrom(d, d.path("betPerLine").asLong()), d.path("scatterCount").asInt(),
                            d.path("freeSpinsAwarded").asInt(), 0, d.path("bonusTriggered").asBoolean(),
                            Money.toTokens(d.path("jackpotWin").asLong()), null, d.path("hmacHash").asText(),
                            d.path("serverSeedHash").asText(), d.path("clientSeed").asText(), d.path("nonce").asLong(),
                            null, "free_spin".equals(d.path("type").asText()));
                })
                .list().stream().filter(java.util.Objects::nonNull).findFirst();
    }

    private SpinResult toResult(UUID roundId, Map<String, Object> data, Symbol[][] grid, long totalBet, long totalWin,
                                int freeAfter, SlotState next, Seed seed, long balance, boolean free) {
        JsonNode d = Json.MAPPER.valueToTree(data);
        return new SpinResult(roundId, gridIds(grid), Money.toTokens(totalBet), Money.toTokens(totalWin),
                linesFrom(d, d.path("betPerLine").asLong()), d.path("scatterCount").asInt(), d.path("freeSpinsAwarded").asInt(),
                freeAfter, d.path("bonusTriggered").asBoolean(), Money.toTokens(d.path("jackpotWin").asLong()), next,
                d.path("hmacHash").asText(), seed.serverSeedHash(), seed.clientSeed(), seed.nonce(),
                Money.toTokens(balance), free);
    }

    private static List<LineView> linesFrom(JsonNode d, long betPerLine) {
        List<LineView> out = new ArrayList<>();
        for (JsonNode l : d.path("lines")) {
            int id = l.path("paylineId").asInt();
            out.add(new LineView(id, l.path("symbol").asText(), l.path("count").asInt(),
                    Money.toTokens(l.path("multiplier").asLong() * betPerLine), SlotMachine.lines()[id - 1]));
        }
        return out;
    }

    static String[][] gridIds(Symbol[][] grid) {
        String[][] ids = new String[grid.length][];
        for (int c = 0; c < grid.length; c++) {
            ids[c] = Arrays.stream(grid[c]).map(Symbol::id).toArray(String[]::new);
        }
        return ids;
    }

    // ------------------------------------------------------------------ provably fair

    private Seed activeSeed(UUID userId) {
        return jdbc.sql("""
                SELECT id, server_seed, server_seed_hash, client_seed, nonce FROM fairness_seeds
                WHERE user_id = ? AND active""")
                .param(userId).query(SlotService::mapSeed).optional()
                .orElseGet(() -> createSeed(userId, ProvablyFairRNG.newClientSeed()));
    }

    private Seed createSeed(UUID userId, String clientSeed) {
        String serverSeed = ProvablyFairRNG.newServerSeed();
        return jdbc.sql("""
                INSERT INTO fairness_seeds (user_id, server_seed, server_seed_hash, client_seed)
                VALUES (?, ?, ?, ?) RETURNING id, server_seed, server_seed_hash, client_seed, nonce""")
                .params(userId, serverSeed, ProvablyFairRNG.sha256(serverSeed), clientSeed)
                .query(SlotService::mapSeed).single();
    }

    /** Locks the active seed, increments the nonce and returns the seed to use for this round. */
    private Seed nextNonce(UUID userId) {
        activeSeed(userId);
        return jdbc.sql("""
                UPDATE fairness_seeds SET nonce = nonce + 1 WHERE user_id = ? AND active
                RETURNING id, server_seed, server_seed_hash, client_seed, nonce""")
                .param(userId).query(SlotService::mapSeed).single();
    }

    private static Seed mapSeed(java.sql.ResultSet rs, int i) throws java.sql.SQLException {
        return new Seed(rs.getObject(1, UUID.class), rs.getString(2), rs.getString(3), rs.getString(4), rs.getLong(5));
    }

    public record FairnessView(String serverSeedHash, String clientSeed, long nonce, String previousServerSeed,
                               String previousServerSeedHash) {}

    /** Reveals the current server seed and starts a new pair (optionally with a player-chosen client seed). */
    @Transactional
    public FairnessView rotateSeed(UUID userId, String newClientSeed) {
        Seed old = activeSeed(userId);
        jdbc.sql("UPDATE fairness_seeds SET active = false, revealed_at = now() WHERE id = ?").param(old.id()).update();
        String client = newClientSeed == null || newClientSeed.isBlank() ? ProvablyFairRNG.newClientSeed() : newClientSeed.strip();
        Seed fresh = createSeed(userId, client);
        return new FairnessView(fresh.serverSeedHash(), fresh.clientSeed(), fresh.nonce(), old.serverSeed(),
                old.serverSeedHash());
    }

    @Transactional
    public FairnessView fairness(UUID userId) {
        Seed s = activeSeed(userId);
        return new FairnessView(s.serverSeedHash(), s.clientSeed(), s.nonce(), null, null);
    }

    /** Re-derives a past round from its (revealed) seed and checks it matches what was stored. */
    public Map<String, Object> verifyRound(UUID userId, UUID roundId) {
        JsonNode d = jdbc.sql("""
                SELECT r.result_data::text FROM slot_rounds r JOIN wallets w ON w.id = r.wallet_id
                WHERE r.id = ? AND w.user_id = ?""")
                .params(roundId, userId).query(String.class).optional().map(Json::read)
                .orElseThrow(() -> new Exceptions.NotFoundException("Round"));
        if (!d.has("seedId")) {
            return Map.of("verifiable", false, "reason", "Bonus rounds are verified through their triggering spin");
        }
        var seed = jdbc.sql("SELECT server_seed, revealed_at FROM fairness_seeds WHERE id = ?")
                .param(UUID.fromString(d.path("seedId").asText()))
                .query((rs, i) -> Map.entry(rs.getString(1), Optional.ofNullable(rs.getTimestamp(2)))).single();
        if (seed.getValue().isEmpty()) {
            return Map.of("verifiable", false, "reason", "Rotate your seed pair to reveal this server seed first",
                    "serverSeedHash", d.path("serverSeedHash").asText());
        }
        String serverSeed = seed.getKey();
        Symbol[][] stored = new Symbol[SlotMachine.COLUMNS][SlotMachine.ROWS];
        for (int c = 0; c < SlotMachine.COLUMNS; c++) {
            for (int r = 0; r < SlotMachine.ROWS; r++) {
                stored[c][r] = SlotMachine.symbol(d.path("grid").get(c).get(r).asText());
            }
        }
        boolean hashOk = ProvablyFairRNG.sha256(serverSeed).equals(d.path("serverSeedHash").asText());
        boolean gridOk = ProvablyFairRNG.verifyResult(serverSeed, d.path("clientSeed").asText(), d.path("nonce").asLong(),
                stored, SlotMachine.ROWS, SlotMachine.REELS);
        return Map.of("verifiable", true, "verified", hashOk && gridOk, "serverSeed", serverSeed,
                "serverSeedHash", d.path("serverSeedHash").asText(), "clientSeed", d.path("clientSeed").asText(),
                "nonce", d.path("nonce").asLong(), "grid", d.path("grid"));
    }

    public record RoundView(UUID id, String type, BigDecimal bet, BigDecimal win, Instant createdAt) {}

    public Cursor.Page<RoundView> history(UUID userId, Cursor cursor, int limit) {
        String where = cursor == null ? "" : "AND (r.created_at, r.id) < (:at, :cid)";
        var spec = jdbc.sql("""
                SELECT r.id, r.result_data->>'type', r.bet_amount, r.win_amount, r.created_at
                FROM slot_rounds r JOIN wallets w ON w.id = r.wallet_id
                WHERE w.user_id = :user %s ORDER BY r.created_at DESC, r.id DESC LIMIT :limit""".formatted(where))
                .param("user", userId).param("limit", limit + 1);
        if (cursor != null) {
            spec = spec.param("at", java.sql.Timestamp.from(cursor.at())).param("cid", cursor.id());
        }
        List<RoundView> rows = spec.query((rs, i) -> new RoundView(rs.getObject(1, UUID.class), rs.getString(2),
                Money.toTokens(rs.getLong(3)), Money.toTokens(rs.getLong(4)), rs.getTimestamp(5).toInstant())).list();
        return Cursor.Page.of(rows, limit, r -> new Cursor(r.createdAt(), r.id()));
    }
}
