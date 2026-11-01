package win.naebka.poker;

/** A playing card, rendered as rank + suit letter, e.g. "As", "Td", "7h". */
public record Card(Suit suit, Rank rank) {

    public enum Suit {
        HEARTS('h'), DIAMONDS('d'), CLUBS('c'), SPADES('s');

        private final char symbol;

        Suit(char symbol) {
            this.symbol = symbol;
        }

        public char symbol() {
            return symbol;
        }
    }

    public enum Rank {
        TWO(2, '2'), THREE(3, '3'), FOUR(4, '4'), FIVE(5, '5'), SIX(6, '6'), SEVEN(7, '7'), EIGHT(8, '8'),
        NINE(9, '9'), TEN(10, 'T'), JACK(11, 'J'), QUEEN(12, 'Q'), KING(13, 'K'), ACE(14, 'A');

        private final int value;
        private final char symbol;

        Rank(int value, char symbol) {
            this.value = value;
            this.symbol = symbol;
        }

        public int getValue() {
            return value;
        }

        public char symbol() {
            return symbol;
        }
    }

    public Suit getSuit() {
        return suit;
    }

    public Rank getRank() {
        return rank;
    }

    public static Card parse(String s) {
        Rank rank = null;
        for (Rank r : Rank.values()) {
            if (r.symbol() == Character.toUpperCase(s.charAt(0))) {
                rank = r;
            }
        }
        Suit suit = null;
        for (Suit su : Suit.values()) {
            if (su.symbol() == Character.toLowerCase(s.charAt(1))) {
                suit = su;
            }
        }
        if (rank == null || suit == null || s.length() != 2) {
            throw new IllegalArgumentException("Bad card " + s);
        }
        return new Card(suit, rank);
    }

    @Override
    public String toString() {
        return "" + rank.symbol() + suit.symbol();
    }
}
