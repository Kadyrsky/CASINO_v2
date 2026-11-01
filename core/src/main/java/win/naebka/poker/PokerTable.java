package win.naebka.poker;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import win.naebka.common.ErrorCode;
import win.naebka.common.Exceptions.GameStateMismatchException;
import win.naebka.common.Exceptions.InvalidBetAmountException;
import win.naebka.poker.Player.PlayerStatus;
import win.naebka.poker.PlayerAction.PlayerActionType;

/**
 * No-Limit Texas Hold'em table state machine (LLD: PokerTable). Not thread-safe by design: every call is
 * made from the table's single actor thread (see {@link PokerTableManager}), which keeps the turn order
 * strictly sequential.
 */
public class PokerTable {
    private final UUID tableId;
    private final String name;
    private final int maxSeats;
    private final long smallBlind;
    private final long bigBlind;
    private final int rakePercent;
    private final long rakeCap;
    private final Player[] seats;
    private final List<Card> communityCards = new ArrayList<>(5);
    private final Deck deck;
    private final PotManager potManager = new PotManager();
    private final List<PokerEventListener> listeners = new ArrayList<>();

    private BettingRound currentRound = BettingRound.PRE_FLOP;
    private int dealerPosition = -1;
    private int currentTurnPosition = -1;
    private long currentHighBet;
    private long lastRaiseSize;
    private boolean handInProgress;
    private long handNumber;
    private long actionSeq;
    private Instant handStartedAt;
    private HandResult lastResult;

    public PokerTable(UUID tableId, String name, int maxSeats, long smallBlind, long bigBlind, int rakePercent,
                      int rakeCapBigBlinds, Deck deck) {
        this.tableId = tableId;
        this.name = name;
        this.maxSeats = maxSeats;
        this.smallBlind = smallBlind;
        this.bigBlind = bigBlind;
        this.rakePercent = rakePercent;
        this.rakeCap = rakeCapBigBlinds * bigBlind;
        this.seats = new Player[maxSeats];
        this.deck = deck;
    }

    public record ShownHand(List<String> cards, String handRank) {}

    public record HandResult(long handNumber, Instant startedAt, Instant endedAt, List<String> board, long rake,
                             Map<UUID, Long> winnings, Map<UUID, Long> contributions, Map<UUID, ShownHand> shown,
                             boolean showdown) {}

    public void addListener(PokerEventListener l) {
        listeners.add(l);
    }

    // ------------------------------------------------------------------ seating

    public boolean addPlayer(Player player, int seatIndex) {
        if (seatIndex < 0 || seatIndex >= maxSeats || seats[seatIndex] != null || findPlayer(player.getId()).isPresent()) {
            return false;
        }
        seats[seatIndex] = player;
        player.setStatus(PlayerStatus.SITTING_OUT);
        notifyState();
        return true;
    }

    /**
     * Stands a player up. Outside a hand (or after folding) they leave immediately; inside a hand they
     * fold now and are removed when the hand ends. Returns the removed player if removal was immediate.
     */
    public Optional<Player> removePlayer(UUID playerId) {
        Player p = findPlayer(playerId).orElse(null);
        if (p == null) {
            return Optional.empty();
        }
        p.setLeaving(true);
        if (handInProgress && p.isInHand() && p.isContesting()) {
            if (isTurnOf(playerId)) {
                applyAction(playerId, PlayerAction.fold());
            } else {
                p.setStatus(PlayerStatus.FOLDED); // folding out of turn is allowed when leaving
                actionSeq++;
                if (contesting().size() == 1) {
                    awardUncontested();
                } else {
                    notifyState();
                }
            }
            return Optional.empty();
        }
        if (handInProgress && p.isInHand()) {
            return Optional.empty(); // folded but chips are in the pot; removed at hand end
        }
        seats[p.getSeatIndex()] = null;
        notifyState();
        return Optional.of(p);
    }

    /** Removes players flagged as leaving (or busted) after a hand; the caller cashes them out. */
    public List<Player> collectLeavers() {
        List<Player> out = new ArrayList<>();
        for (int i = 0; i < maxSeats; i++) {
            Player p = seats[i];
            if (p != null && !handInProgress && (p.isLeaving() || p.getChipStack() == 0)) {
                seats[i] = null;
                out.add(p);
            }
        }
        if (!out.isEmpty()) {
            notifyState();
        }
        return out;
    }

    // ------------------------------------------------------------------ hand lifecycle

    public boolean canStartHand() {
        return !handInProgress && eligiblePlayers().size() >= 2;
    }

    public boolean startHand() {
        if (handInProgress) {
            throw new GameStateMismatchException("A hand is already in progress");
        }
        List<Player> eligible = eligiblePlayers();
        if (eligible.size() < 2) {
            return false;
        }
        handNumber++;
        actionSeq++;
        handStartedAt = Instant.now();
        communityCards.clear();
        potManager.reset();
        deck.reset();
        deck.shuffle();
        currentRound = BettingRound.PRE_FLOP;
        lastResult = null;
        for (Player p : seats) {
            if (p != null) {
                p.clearHand();
                p.setStatus(PlayerStatus.SITTING_OUT);
            }
        }
        for (Player p : eligible) {
            p.setInHand(true);
            p.setStatus(PlayerStatus.ACTIVE);
        }
        handInProgress = true;

        dealerPosition = nextSeat(dealerPosition, Player::isInHand);
        int sbPos;
        int bbPos;
        if (eligible.size() == 2) {
            sbPos = dealerPosition; // heads-up: the button posts the small blind and acts first pre-flop
            bbPos = nextSeat(sbPos, Player::isInHand);
        } else {
            sbPos = nextSeat(dealerPosition, Player::isInHand);
            bbPos = nextSeat(sbPos, Player::isInHand);
        }
        post(seats[sbPos], smallBlind);
        post(seats[bbPos], bigBlind);
        currentHighBet = bigBlind;
        lastRaiseSize = bigBlind;

        for (int round = 0; round < 2; round++) {
            int pos = dealerPosition;
            for (int i = 0; i < eligible.size(); i++) {
                pos = nextSeat(pos, Player::isInHand);
                seats[pos].receiveCard(deck.drawCard());
            }
        }

        int first = eligible.size() == 2 ? sbPos : nextSeat(bbPos, Player::isInHand);
        currentTurnPosition = first;
        if (!needsToAct(seats[first])) {
            currentTurnPosition = nextNeedingAction(first);
        }
        if (currentTurnPosition < 0) {
            endRound();
        } else {
            notifyState();
        }
        return true;
    }

    private void post(Player p, long blind) {
        p.deductChips(Math.min(blind, p.getChipStack()));
    }

    public boolean applyAction(UUID playerId, PlayerAction action) {
        if (!handInProgress) {
            throw new GameStateMismatchException("No hand in progress");
        }
        if (!isTurnOf(playerId)) {
            throw new GameStateMismatchException("It is not your turn");
        }
        Player p = seats[currentTurnPosition];
        long toCall = currentHighBet - p.getCurrentBet();
        switch (action.type()) {
            case FOLD -> p.setStatus(PlayerStatus.FOLDED);
            case CHECK -> {
                if (toCall > 0) {
                    throw new GameStateMismatchException("Cannot check: " + toCall + " to call");
                }
            }
            case CALL -> {
                if (toCall > 0) {
                    p.deductChips(Math.min(toCall, p.getChipStack()));
                }
            }
            case BET, RAISE -> commitTo(p, action.amount());
            case ALL_IN -> commitTo(p, p.getCurrentBet() + p.getChipStack());
        }
        p.setHasActed(true);
        actionSeq++;
        for (PokerEventListener l : listeners) {
            l.onPlayerActed(this, playerId, action);
        }
        progress();
        return true;
    }

    /** Bet or raise so that the player has {@code to} in front of them this round. */
    private void commitTo(Player p, long to) {
        long maxTo = p.getCurrentBet() + p.getChipStack();
        boolean allIn = to == maxTo;
        if (to > maxTo || to <= p.getCurrentBet()) {
            throw invalid("Amount must be between " + (p.getCurrentBet() + 1) + " and " + maxTo);
        }
        if (to <= currentHighBet) {
            if (!allIn) {
                throw invalid("A raise must be more than the current bet of " + currentHighBet);
            }
            p.deductChips(to - p.getCurrentBet()); // all-in for less than a call
            return;
        }
        long minTo = currentHighBet == 0 ? bigBlind : currentHighBet + lastRaiseSize;
        if (to < minTo && !allIn) {
            throw invalid("Minimum " + (currentHighBet == 0 ? "bet" : "raise") + " is to " + minTo);
        }
        long increment = to - currentHighBet;
        p.deductChips(to - p.getCurrentBet());
        if (increment >= lastRaiseSize) {
            lastRaiseSize = increment;
            // A full raise reopens the action for everyone else.
            for (Player other : seats) {
                if (other != null && other != p && other.canAct()) {
                    other.setHasActed(false);
                }
            }
        }
        currentHighBet = to;
    }

    private static InvalidBetAmountException invalid(String message) {
        return new InvalidBetAmountException(ErrorCode.INVALID_AMOUNT, message, Map.of());
    }

    /** Turn timer expired (or the player is away): check if free, otherwise fold (LLD auto-action policy). */
    public void handleTimeout(UUID playerId) {
        if (!handInProgress || !isTurnOf(playerId)) {
            return;
        }
        Player p = seats[currentTurnPosition];
        int timeouts = p.getConsecutiveTimeouts() + 1;
        applyAction(playerId, currentHighBet - p.getCurrentBet() == 0 ? PlayerAction.check() : PlayerAction.fold());
        p.setConsecutiveTimeouts(timeouts);
        if (timeouts >= 2) {
            p.setSittingOut(true);
            notifyState();
        }
    }

    private void progress() {
        if (contesting().size() == 1) {
            awardUncontested();
            return;
        }
        int next = nextNeedingAction(currentTurnPosition);
        if (next >= 0) {
            currentTurnPosition = next;
            notifyState();
            return;
        }
        endRound();
    }

    private void endRound() {
        while (true) {
            for (Player p : seats) {
                if (p != null) {
                    p.resetRoundBet();
                    p.setHasActed(false);
                }
            }
            currentHighBet = 0;
            lastRaiseSize = bigBlind;
            if (currentRound == BettingRound.RIVER) {
                executeShowdown();
                return;
            }
            nextBettingRound();
            long canAct = inHandPlayers().stream().filter(Player::canAct).count();
            if (canAct >= 2) {
                currentTurnPosition = nextNeedingAction(dealerPosition);
                actionSeq++;
                notifyState();
                return;
            }
            // Everyone (or all but one) is all-in: run the board out.
        }
    }

    private void nextBettingRound() {
        switch (currentRound) {
            case PRE_FLOP -> {
                dealCommunityCards(3);
                currentRound = BettingRound.FLOP;
            }
            case FLOP -> {
                dealCommunityCards(1);
                currentRound = BettingRound.TURN;
            }
            case TURN -> {
                dealCommunityCards(1);
                currentRound = BettingRound.RIVER;
            }
            default -> throw new IllegalStateException("No round after " + currentRound);
        }
    }

    private void dealCommunityCards(int count) {
        deck.drawCard(); // burn
        for (int i = 0; i < count; i++) {
            communityCards.add(deck.drawCard());
        }
    }

    private long rakeFor(long pot) {
        if (communityCards.isEmpty()) {
            return 0; // no flop, no drop
        }
        return Math.min(rakeCap, pot * rakePercent / 100);
    }

    private Map<UUID, Long> executeShowdown() {
        currentRound = BettingRound.SHOWDOWN;
        List<Player> inHand = inHandPlayers();
        List<Pot> pots = potManager.calculateSidePots(inHand);
        long total = potManager.total(inHand);
        long rake = rakeFor(total);
        long rakeLeft = rake;
        for (Pot pot : pots) {
            long take = Math.min(rakeLeft, pot.getAmount());
            pot.addAmount(-take);
            rakeLeft -= take;
        }

        Map<UUID, HandEvaluation> evals = new LinkedHashMap<>();
        Map<UUID, ShownHand> shown = new LinkedHashMap<>();
        for (Player p : contesting()) {
            HandEvaluation e = HandEvaluator.evaluate(p.getHoleCards(), communityCards);
            evals.put(p.getId(), e);
            shown.put(p.getId(), new ShownHand(cardStrings(p.getHoleCards()), e.describe()));
        }

        Map<UUID, Long> winnings = new LinkedHashMap<>();
        for (Pot pot : pots) {
            List<Player> eligible = orderFromDealer(contesting()).stream()
                    .filter(p -> pot.getEligiblePlayerIds().contains(p.getId())).toList();
            if (eligible.isEmpty() || pot.getAmount() == 0) {
                continue;
            }
            HandEvaluation best = eligible.stream().map(p -> evals.get(p.getId())).max(HandEvaluation::compareTo).orElseThrow();
            List<Player> winners = eligible.stream().filter(p -> evals.get(p.getId()).compareTo(best) == 0).toList();
            long share = pot.splitPot(winners.size());
            long odd = pot.remainder(winners.size());
            for (int i = 0; i < winners.size(); i++) {
                long won = share + (i == 0 ? odd : 0); // odd chip to the first winner left of the button
                winners.get(i).addChips(won);
                winnings.merge(winners.get(i).getId(), won, Long::sum);
            }
        }
        finishHand(rake, winnings, shown, true);
        return winnings;
    }

    private void awardUncontested() {
        List<Player> inHand = inHandPlayers();
        Player winner = contesting().getFirst();
        long total = potManager.total(inHand);
        long rake = rakeFor(total);
        winner.addChips(total - rake);
        finishHand(rake, Map.of(winner.getId(), total - rake), Map.of(), false);
    }

    private void finishHand(long rake, Map<UUID, Long> winnings, Map<UUID, ShownHand> shown, boolean showdown) {
        Map<UUID, Long> contributions = new LinkedHashMap<>();
        for (Player p : inHandPlayers()) {
            contributions.put(p.getId(), p.getTotalBet());
        }
        lastResult = new HandResult(handNumber, handStartedAt, Instant.now(), cardStrings(communityCards), rake,
                Map.copyOf(winnings), contributions, Map.copyOf(shown), showdown);
        handInProgress = false;
        currentTurnPosition = -1;
        actionSeq++;
        for (Player p : seats) {
            if (p != null) {
                p.setInHand(false); // statuses stay as they were for display until the next deal
            }
        }
        for (PokerEventListener l : listeners) {
            l.onHandCompleted(this, lastResult);
        }
        notifyState();
    }

    // ------------------------------------------------------------------ helpers

    private boolean needsToAct(Player p) {
        return p != null && p.canAct() && (!p.hasActed() || p.getCurrentBet() < currentHighBet);
    }

    /** Next seat clockwise after {@code from} whose player needs to act, or -1. */
    private int nextNeedingAction(int from) {
        for (int i = 1; i <= maxSeats; i++) {
            int pos = Math.floorMod(from + i, maxSeats);
            if (needsToAct(seats[pos])) {
                return pos;
            }
        }
        return -1;
    }

    private int nextSeat(int from, java.util.function.Predicate<Player> filter) {
        for (int i = 1; i <= maxSeats; i++) {
            int pos = Math.floorMod(from + i, maxSeats);
            if (seats[pos] != null && filter.test(seats[pos])) {
                return pos;
            }
        }
        throw new IllegalStateException("No matching seat");
    }

    private List<Player> eligiblePlayers() {
        List<Player> out = new ArrayList<>();
        for (Player p : seats) {
            if (p != null && !p.isSittingOut() && !p.isLeaving() && p.getChipStack() > 0) {
                out.add(p);
            }
        }
        return out;
    }

    private List<Player> inHandPlayers() {
        List<Player> out = new ArrayList<>();
        for (Player p : seats) {
            if (p != null && p.isInHand()) {
                out.add(p);
            }
        }
        return out;
    }

    private List<Player> contesting() {
        return inHandPlayers().stream().filter(Player::isContesting).toList();
    }

    private List<Player> orderFromDealer(List<Player> players) {
        List<Player> out = new ArrayList<>();
        for (int i = 1; i <= maxSeats; i++) {
            Player p = seats[Math.floorMod(dealerPosition + i, maxSeats)];
            if (p != null && players.contains(p)) {
                out.add(p);
            }
        }
        return out;
    }

    private static List<String> cardStrings(List<Card> cards) {
        return cards.stream().map(Card::toString).toList();
    }

    private void notifyState() {
        for (PokerEventListener l : listeners) {
            l.onGameStateChanged(this);
        }
    }

    public boolean isTurnOf(UUID playerId) {
        return handInProgress && currentTurnPosition >= 0 && seats[currentTurnPosition] != null
                && seats[currentTurnPosition].getId().equals(playerId);
    }

    public Optional<Player> findPlayer(UUID playerId) {
        for (Player p : seats) {
            if (p != null && p.getId().equals(playerId)) {
                return Optional.of(p);
            }
        }
        return Optional.empty();
    }

    public Optional<Player> currentPlayer() {
        return handInProgress && currentTurnPosition >= 0 ? Optional.ofNullable(seats[currentTurnPosition]) : Optional.empty();
    }

    public int seatedCount() {
        int n = 0;
        for (Player p : seats) {
            n += p == null ? 0 : 1;
        }
        return n;
    }

    public List<Player> seatedPlayers() {
        List<Player> out = new ArrayList<>();
        for (Player p : seats) {
            if (p != null) {
                out.add(p);
            }
        }
        return out;
    }

    // ------------------------------------------------------------------ views (GameStateDTO)

    /** Public table state. Hole cards are always redacted to ["HIDDEN","HIDDEN"] (LLD: server-side card masking). */
    public Map<String, Object> publicState() {
        Map<String, Object> s = new LinkedHashMap<>();
        s.put("tableId", tableId);
        s.put("name", name);
        s.put("smallBlind", smallBlind);
        s.put("bigBlind", bigBlind);
        s.put("maxSeats", maxSeats);
        s.put("handNumber", handNumber);
        s.put("handInProgress", handInProgress);
        s.put("round", handInProgress ? currentRound : null);
        s.put("board", cardStrings(communityCards));
        List<Player> inHand = inHandPlayers();
        s.put("pot", handInProgress ? potManager.total(inHand) : 0);
        s.put("pots", handInProgress ? potManager.calculateSidePots(inHand).stream()
                .map(p -> Map.of("amount", p.getAmount(), "eligible", p.getEligiblePlayerIds())).toList() : List.of());
        s.put("currentHighBet", currentHighBet);
        s.put("dealerSeat", dealerPosition);
        s.put("turnSeat", currentTurnPosition);
        List<Map<String, Object>> seatViews = new ArrayList<>();
        for (int i = 0; i < maxSeats; i++) {
            Player p = seats[i];
            Map<String, Object> v = new LinkedHashMap<>();
            v.put("seatNo", i);
            if (p != null) {
                v.put("userId", p.getId());
                v.put("username", p.getUsername());
                v.put("stack", p.getChipStack());
                v.put("currentBet", p.getCurrentBet());
                v.put("status", p.getStatus());
                v.put("inHand", p.isInHand());
                v.put("sittingOut", p.isSittingOut());
                v.put("connected", p.isConnected());
                v.put("cards", p.isInHand() && p.isContesting() ? List.of("HIDDEN", "HIDDEN") : List.of());
            }
            seatViews.add(v);
        }
        s.put("seats", seatViews);
        if (lastResult != null && !handInProgress) {
            s.put("lastResult", lastResult);
        }
        return s;
    }

    /** What only {@code playerId} may see: their hole cards and, on their turn, the legal actions. */
    public Map<String, Object> privateState(UUID playerId) {
        Map<String, Object> s = new LinkedHashMap<>();
        s.put("tableId", tableId);
        Player p = findPlayer(playerId).orElse(null);
        if (p == null) {
            s.put("seated", false);
            return s;
        }
        s.put("seated", true);
        s.put("seatNo", p.getSeatIndex());
        s.put("holeCards", cardStrings(p.getHoleCards()));
        s.put("sittingOut", p.isSittingOut());
        if (isTurnOf(playerId)) {
            long toCall = currentHighBet - p.getCurrentBet();
            long maxTo = p.getCurrentBet() + p.getChipStack();
            long minTo = Math.min(maxTo, currentHighBet == 0 ? bigBlind : currentHighBet + lastRaiseSize);
            Map<String, Object> legal = new LinkedHashMap<>();
            legal.put("canCheck", toCall == 0);
            legal.put("toCall", Math.min(toCall, p.getChipStack()));
            legal.put("canRaise", p.getChipStack() > toCall);
            legal.put("raiseType", currentHighBet == 0 ? PlayerActionType.BET : PlayerActionType.RAISE);
            legal.put("minRaiseTo", minTo);
            legal.put("maxRaiseTo", maxTo);
            s.put("legalActions", legal);
        }
        return s;
    }

    public UUID getTableId() {
        return tableId;
    }

    public String getName() {
        return name;
    }

    public int getMaxSeats() {
        return maxSeats;
    }

    public long getSmallBlind() {
        return smallBlind;
    }

    public long getBigBlind() {
        return bigBlind;
    }

    public boolean isHandInProgress() {
        return handInProgress;
    }

    public long getActionSeq() {
        return actionSeq;
    }

    public List<Card> getCommunityCards() {
        return communityCards;
    }

    public BettingRound getCurrentRound() {
        return currentRound;
    }

    public long getCurrentHighBet() {
        return currentHighBet;
    }

    public HandResult getLastResult() {
        return lastResult;
    }

    Deck deck() {
        return deck;
    }
}
