package win.naebka.poker;

import java.util.List;

/**
 * The value of a best five-card hand: its category plus tie-breaking rank values in significance order
 * (e.g. two pair K-K-7-7-A → [13, 7, 14]).
 */
public record HandEvaluation(HandRank handRank, List<Integer> kickers, List<Card> bestFive)
        implements Comparable<HandEvaluation> {

    @Override
    public int compareTo(HandEvaluation other) {
        int c = Integer.compare(handRank.getWeight(), other.handRank.getWeight());
        if (c != 0) {
            return c;
        }
        for (int i = 0; i < Math.min(kickers.size(), other.kickers.size()); i++) {
            c = Integer.compare(kickers.get(i), other.kickers.get(i));
            if (c != 0) {
                return c;
            }
        }
        return 0;
    }

    public String describe() {
        return handRank.name().replace('_', ' ').toLowerCase();
    }
}
