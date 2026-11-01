package win.naebka.poker;

import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Random;

/** A 52-card deck shuffled with a cryptographically secure RNG. */
public class Deck {
    private final Random random;
    private final List<Card> cards = new ArrayList<>(52);

    public Deck() {
        this(new SecureRandom());
    }

    /** Tests pass a seeded Random for deterministic deals. */
    public Deck(Random random) {
        this.random = random;
        reset();
    }

    public final void reset() {
        cards.clear();
        for (Card.Suit s : Card.Suit.values()) {
            for (Card.Rank r : Card.Rank.values()) {
                cards.add(new Card(s, r));
            }
        }
    }

    public void shuffle() {
        Collections.shuffle(cards, random);
    }

    public Card drawCard() {
        if (cards.isEmpty()) {
            throw new IllegalStateException("Deck is empty");
        }
        return cards.removeLast();
    }

    /** Puts specific cards on top (tests only). */
    void stack(List<Card> topFirst) {
        cards.removeAll(topFirst);
        for (int i = topFirst.size() - 1; i >= 0; i--) {
            cards.add(topFirst.get(i));
        }
    }

    public int remaining() {
        return cards.size();
    }
}
