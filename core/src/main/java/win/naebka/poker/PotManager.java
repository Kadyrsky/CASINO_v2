package win.naebka.poker;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;

/**
 * Builds the main pot and side pots from what every player put in this hand. Each distinct all-in
 * level caps a pot; folded players' chips stay in the pots but they are never eligible to win.
 */
public class PotManager {
    private Pot mainPot = new Pot(0, Set.of());
    private List<Pot> sidePots = new ArrayList<>();

    public void collectBets(List<Player> players) {
        List<Pot> pots = calculateSidePots(players);
        mainPot = pots.isEmpty() ? new Pot(0, Set.of()) : pots.get(0);
        sidePots = pots.size() > 1 ? new ArrayList<>(pots.subList(1, pots.size())) : new ArrayList<>();
    }

    public List<Pot> calculateSidePots(List<Player> players) {
        List<Long> levels = players.stream()
                .filter(p -> p.isContesting() && p.getTotalBet() > 0)
                .map(Player::getTotalBet).distinct().sorted().toList();
        List<Pot> pots = new ArrayList<>();
        long previous = 0;
        for (long level : levels) {
            long amount = 0;
            Set<UUID> eligible = new LinkedHashSet<>();
            for (Player p : players) {
                amount += Math.max(0, Math.min(p.getTotalBet(), level) - previous);
                if (p.isContesting() && p.getTotalBet() >= level) {
                    eligible.add(p.getId());
                }
            }
            if (amount > 0) {
                pots.add(new Pot(amount, eligible));
            }
            previous = level;
        }
        // Chips of folded players above the highest contesting level (e.g. a folded over-bet) go to the last pot.
        long leftover = 0;
        for (Player p : players) {
            leftover += Math.max(0, p.getTotalBet() - previous);
        }
        if (leftover > 0 && !pots.isEmpty()) {
            pots.getLast().addAmount(leftover);
        }
        return pots;
    }

    public long total(List<Player> players) {
        return players.stream().mapToLong(Player::getTotalBet).sum();
    }

    public Pot getMainPot() {
        return mainPot;
    }

    public List<Pot> getSidePots() {
        return sidePots;
    }

    public void reset() {
        mainPot = new Pot(0, Set.of());
        sidePots = new ArrayList<>();
    }
}
