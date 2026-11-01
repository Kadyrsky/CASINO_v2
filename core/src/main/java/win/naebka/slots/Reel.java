package win.naebka.slots;

import java.util.List;

/** A physical reel strip; a spin picks a stop and shows {@code rows} consecutive symbols from it. */
public record Reel(int reelIndex, List<Symbol> availableSymbols) {

    public int stopFor(double randomFloat) {
        return (int) Math.floor(randomFloat * availableSymbols.size());
    }

    public Symbol[] window(int stop, int rows) {
        Symbol[] out = new Symbol[rows];
        for (int r = 0; r < rows; r++) {
            out[r] = availableSymbols.get((stop + r) % availableSymbols.size());
        }
        return out;
    }
}
