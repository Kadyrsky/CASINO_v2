package win.naebka.slots;

import java.util.Map;

/**
 * A reel symbol. {@code payoutMultipliers} maps "symbols in a row from the left" to the win in
 * multiples of the line bet. MULTIPLIER acts as a wild that doubles the line it completes.
 */
public record Symbol(String id, String name, SymbolType type, Map<Integer, Integer> payoutMultipliers) {

    public boolean isWild() {
        return type == SymbolType.WILD || type == SymbolType.MULTIPLIER;
    }

    public boolean isScatter() {
        return type == SymbolType.SCATTER;
    }

    public boolean isBonus() {
        return type == SymbolType.BONUS;
    }

    public int getPayoutForCount(int count) {
        return payoutMultipliers.getOrDefault(count, 0);
    }
}
