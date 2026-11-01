package win.naebka.poker;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/** Finds the best five-card hand out of hole cards + community cards (all 21 combinations of 7). */
public final class HandEvaluator {

    private HandEvaluator() {}

    public static HandEvaluation evaluate(List<Card> holeCards, List<Card> communityCards) {
        List<Card> all = new ArrayList<>(holeCards);
        all.addAll(communityCards);
        if (all.size() < 5) {
            throw new IllegalArgumentException("Need at least 5 cards");
        }
        HandEvaluation best = null;
        int n = all.size();
        for (int a = 0; a < n; a++) {
            for (int b = a + 1; b < n; b++) {
                for (int c = b + 1; c < n; c++) {
                    for (int d = c + 1; d < n; d++) {
                        for (int e = d + 1; e < n; e++) {
                            HandEvaluation h = evaluateFive(List.of(all.get(a), all.get(b), all.get(c), all.get(d), all.get(e)));
                            if (best == null || h.compareTo(best) > 0) {
                                best = h;
                            }
                        }
                    }
                }
            }
        }
        return best;
    }

    static HandEvaluation evaluateFive(List<Card> five) {
        List<Card> sorted = new ArrayList<>(five);
        sorted.sort(Comparator.comparingInt((Card c) -> c.rank().getValue()).reversed());

        boolean flush = sorted.stream().allMatch(c -> c.suit() == sorted.get(0).suit());
        int straightHigh = straightHigh(sorted);

        // rank value -> count, ordered by (count desc, rank desc)
        Map<Integer, Integer> counts = new TreeMap<>(Comparator.reverseOrder());
        for (Card c : sorted) {
            counts.merge(c.rank().getValue(), 1, Integer::sum);
        }
        List<Integer> groups = new ArrayList<>(counts.keySet());
        groups.sort((x, y) -> {
            int byCount = Integer.compare(counts.get(y), counts.get(x));
            return byCount != 0 ? byCount : Integer.compare(y, x);
        });
        int top = counts.get(groups.get(0));
        int second = groups.size() > 1 ? counts.get(groups.get(1)) : 0;

        if (flush && straightHigh > 0) {
            return new HandEvaluation(straightHigh == 14 ? HandRank.ROYAL_FLUSH : HandRank.STRAIGHT_FLUSH,
                    List.of(straightHigh), sorted);
        }
        if (top == 4) {
            return new HandEvaluation(HandRank.FOUR_OF_A_KIND, groups, sorted);
        }
        if (top == 3 && second == 2) {
            return new HandEvaluation(HandRank.FULL_HOUSE, groups, sorted);
        }
        if (flush) {
            return new HandEvaluation(HandRank.FLUSH, values(sorted), sorted);
        }
        if (straightHigh > 0) {
            return new HandEvaluation(HandRank.STRAIGHT, List.of(straightHigh), sorted);
        }
        if (top == 3) {
            return new HandEvaluation(HandRank.THREE_OF_A_KIND, groups, sorted);
        }
        if (top == 2 && second == 2) {
            return new HandEvaluation(HandRank.TWO_PAIR, groups, sorted);
        }
        if (top == 2) {
            return new HandEvaluation(HandRank.ONE_PAIR, groups, sorted);
        }
        return new HandEvaluation(HandRank.HIGH_CARD, values(sorted), sorted);
    }

    private static List<Integer> values(List<Card> sorted) {
        return sorted.stream().map(c -> c.rank().getValue()).toList();
    }

    /** High card of a straight in these five (sorted desc) cards, 5 for the wheel A-2-3-4-5, 0 if none. */
    private static int straightHigh(List<Card> sorted) {
        List<Integer> v = values(sorted);
        if (v.stream().distinct().count() != 5) {
            return 0;
        }
        if (v.get(0) - v.get(4) == 4) {
            return v.get(0);
        }
        if (v.equals(List.of(14, 5, 4, 3, 2))) {
            return 5;
        }
        return 0;
    }
}
