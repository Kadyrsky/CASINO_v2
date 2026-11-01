package win.naebka.slots;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import win.naebka.common.Exceptions.GameStateMismatchException;

/**
 * Pick-and-click bonus: 12 closed boxes hide multiples of the total bet; the player opens 3.
 * The rewards are shuffled with the provably-fair floats of the triggering spin, so the hidden layout is
 * fixed (and verifiable) before the first pick.
 */
public class PickAndClickBonus extends BonusGame {
    public static final int[] REWARD_MULTIPLIERS = {1, 1, 2, 2, 3, 3, 5, 5, 8, 10, 15, 25};
    public static final int PICKS = 3;

    private final List<Long> hiddenRewards;
    private final List<Integer> picked;

    public PickAndClickBonus(UUID playerId, List<Long> hiddenRewards, List<Integer> picked, int remainingAttempts,
                             long totalBonusWin) {
        super(playerId, remainingAttempts, totalBonusWin);
        this.hiddenRewards = List.copyOf(hiddenRewards);
        this.picked = new ArrayList<>(picked);
    }

    /** Fisher–Yates shuffle of the reward table driven by provably-fair floats. */
    public static PickAndClickBonus create(UUID playerId, long totalBet, double[] floats) {
        List<Long> rewards = new ArrayList<>();
        for (int m : REWARD_MULTIPLIERS) {
            rewards.add(m * totalBet);
        }
        for (int i = rewards.size() - 1, f = 0; i > 0; i--, f++) {
            int j = (int) Math.floor(floats[f % floats.length] * (i + 1));
            Long tmp = rewards.get(i);
            rewards.set(i, rewards.get(j));
            rewards.set(j, tmp);
        }
        return new PickAndClickBonus(playerId, rewards, List.of(), PICKS, 0);
    }

    @Override
    public BonusTurnResult playTurn(int choice) {
        if (isCompleted()) {
            throw new GameStateMismatchException("Bonus game is already finished");
        }
        if (choice < 0 || choice >= hiddenRewards.size() || picked.contains(choice)) {
            throw new GameStateMismatchException("Box " + choice + " cannot be picked");
        }
        long reward = hiddenRewards.get(choice);
        picked.add(choice);
        remainingAttempts--;
        totalBonusWin += reward;
        return new BonusTurnResult(choice, reward, totalBonusWin, remainingAttempts, isCompleted());
    }

    public List<Long> hiddenRewards() {
        return hiddenRewards;
    }

    public List<Integer> picked() {
        return List.copyOf(picked);
    }

    public int boxCount() {
        return hiddenRewards.size();
    }
}
