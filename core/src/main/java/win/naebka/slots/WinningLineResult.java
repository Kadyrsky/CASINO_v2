package win.naebka.slots;

/** A paying line: {@code lineMultiplier} × line bet. {@code jackpot} = five wilds on the line. */
public record WinningLineResult(int paylineId, Symbol winningSymbol, int symbolCount, int lineMultiplier,
                                boolean jackpot) {}
