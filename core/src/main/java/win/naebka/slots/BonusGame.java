package win.naebka.slots;

import java.util.UUID;

/** A bonus round played after a trigger (LLD: abstract BonusGame). */
public abstract class BonusGame {
    protected final UUID playerId;
    protected int remainingAttempts;
    protected long totalBonusWin;

    protected BonusGame(UUID playerId, int remainingAttempts, long totalBonusWin) {
        this.playerId = playerId;
        this.remainingAttempts = remainingAttempts;
        this.totalBonusWin = totalBonusWin;
    }

    public record BonusTurnResult(int choice, long reward, long totalBonusWin, int remainingAttempts, boolean completed) {}

    public abstract BonusTurnResult playTurn(int choice);

    public boolean isCompleted() {
        return remainingAttempts <= 0;
    }

    public long totalBonusWin() {
        return totalBonusWin;
    }
}
