package win.naebka.poker;

import java.util.LinkedHashSet;
import java.util.Set;
import java.util.UUID;

/** A main or side pot and the players who can win it. */
public class Pot {
    private long amount;
    private final Set<UUID> eligiblePlayerIds;

    public Pot(long amount, Set<UUID> eligiblePlayerIds) {
        this.amount = amount;
        this.eligiblePlayerIds = new LinkedHashSet<>(eligiblePlayerIds);
    }

    public void addAmount(long amt) {
        amount += amt;
    }

    /** Equal share per winner; the odd chips are returned separately by {@link #remainder(int)}. */
    public long splitPot(int winnersCount) {
        return amount / winnersCount;
    }

    public long remainder(int winnersCount) {
        return amount % winnersCount;
    }

    public long getAmount() {
        return amount;
    }

    public Set<UUID> getEligiblePlayerIds() {
        return eligiblePlayerIds;
    }
}
