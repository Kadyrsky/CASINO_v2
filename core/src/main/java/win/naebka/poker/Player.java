package win.naebka.poker;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import win.naebka.common.Exceptions.InsufficientBalanceException;

/** A player seated at a table. Chips are minor units of NTK moved from the wallet on sitting down. */
public class Player {
    public enum PlayerStatus { ACTIVE, FOLDED, ALL_IN, SITTING_OUT }

    private final UUID id;
    private final String username;
    private final int seatIndex;
    private final String ip;
    private final UUID seatRowId;
    private long chipStack;
    private long currentBet;   // committed in the current betting round
    private long totalBet;     // committed in the whole hand
    private final List<Card> holeCards = new ArrayList<>(2);
    private PlayerStatus status = PlayerStatus.SITTING_OUT;
    private boolean inHand;
    private boolean hasActed;
    private boolean connected = true;
    private boolean leaving;
    private boolean sittingOut;
    private int consecutiveTimeouts;

    public Player(UUID id, String username, int seatIndex, long chipStack, String ip, UUID seatRowId) {
        this.id = id;
        this.username = username;
        this.seatIndex = seatIndex;
        this.chipStack = chipStack;
        this.ip = ip;
        this.seatRowId = seatRowId;
    }

    public void receiveCard(Card card) {
        holeCards.add(card);
    }

    public void clearHand() {
        holeCards.clear();
        currentBet = 0;
        totalBet = 0;
        hasActed = false;
        inHand = false;
    }

    /** Moves up to {@code amount} from the stack into the pot; returns what was actually moved. */
    public long deductChips(long amount) {
        if (amount < 0 || amount > chipStack) {
            throw new InsufficientBalanceException();
        }
        chipStack -= amount;
        currentBet += amount;
        totalBet += amount;
        if (chipStack == 0 && inHand) {
            status = PlayerStatus.ALL_IN;
        }
        return amount;
    }

    public void addChips(long amount) {
        chipStack += amount;
    }

    public UUID getId() {
        return id;
    }

    public String getUsername() {
        return username;
    }

    public int getSeatIndex() {
        return seatIndex;
    }

    public String getIp() {
        return ip;
    }

    public UUID getSeatRowId() {
        return seatRowId;
    }

    public long getChipStack() {
        return chipStack;
    }

    public long getCurrentBet() {
        return currentBet;
    }

    public void resetRoundBet() {
        currentBet = 0;
    }

    public long getTotalBet() {
        return totalBet;
    }

    public List<Card> getHoleCards() {
        return holeCards;
    }

    public PlayerStatus getStatus() {
        return status;
    }

    public void setStatus(PlayerStatus status) {
        this.status = status;
    }

    public boolean isInHand() {
        return inHand;
    }

    public void setInHand(boolean inHand) {
        this.inHand = inHand;
    }

    /** Still contesting the pot (not folded, dealt in). */
    public boolean isContesting() {
        return inHand && status != PlayerStatus.FOLDED;
    }

    /** Can still make decisions this hand. */
    public boolean canAct() {
        return inHand && status == PlayerStatus.ACTIVE;
    }

    public boolean hasActed() {
        return hasActed;
    }

    public void setHasActed(boolean hasActed) {
        this.hasActed = hasActed;
    }

    public boolean isConnected() {
        return connected;
    }

    public void setConnected(boolean connected) {
        this.connected = connected;
    }

    public boolean isLeaving() {
        return leaving;
    }

    public void setLeaving(boolean leaving) {
        this.leaving = leaving;
    }

    /** Sitting out: keeps the seat and chips but is not dealt in (timeouts, disconnects, or by choice). */
    public boolean isSittingOut() {
        return sittingOut;
    }

    public void setSittingOut(boolean sittingOut) {
        this.sittingOut = sittingOut;
    }

    public int getConsecutiveTimeouts() {
        return consecutiveTimeouts;
    }

    public void setConsecutiveTimeouts(int consecutiveTimeouts) {
        this.consecutiveTimeouts = consecutiveTimeouts;
    }
}
