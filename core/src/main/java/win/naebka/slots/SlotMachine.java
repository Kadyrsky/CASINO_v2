package win.naebka.slots;

import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * "Soul Reels": 5 reels × 3 rows, 10 paylines. Pure game logic — no money, no persistence — so it can
 * be simulated millions of times in tests (target RTP ≈ 95–96%, see SlotMachineTest).
 */
public final class SlotMachine {
    public static final int ROWS = 3;
    public static final int COLUMNS = 5;

    private static final Map<String, Symbol> SYMBOLS = new LinkedHashMap<>();

    // Deadlock-themed: cheap shop items are the low symbols, map objectives the high ones. The ids are the original
    // ones, so rounds played before the theme still read and verify the same.
    static {
        regular("CHERRY", "Extended Magazine", 4, 10, 40);
        regular("LEMON", "Extra Health", 4, 10, 40);
        regular("BELL", "Extra Spirit", 8, 25, 80);
        regular("CLOVER", "Guardian", 10, 30, 100);
        regular("GEM", "Walker", 20, 75, 250);
        regular("SEVEN", "Rejuvenator", 40, 150, 600);
        SYMBOLS.put("WILD", new Symbol("WILD", "Hidden King", SymbolType.WILD, Map.of(3, 50, 4, 250, 5, 2000)));
        SYMBOLS.put("MULT", new Symbol("MULT", "Archmother x2", SymbolType.MULTIPLIER, Map.of()));
        SYMBOLS.put("SCATTER", new Symbol("SCATTER", "Soul Urn", SymbolType.SCATTER, Map.of()));
        SYMBOLS.put("BONUS", new Symbol("BONUS", "Unstable Rift", SymbolType.BONUS, Map.of()));
    }

    private static void regular(String id, String name, int three, int four, int five) {
        SYMBOLS.put(id, new Symbol(id, name, SymbolType.REGULAR, Map.of(3, three, 4, four, 5, five)));
    }

    private static final String[] STRIP_A = {"SEVEN", "LEMON", "CLOVER", "LEMON", "WILD", "CHERRY", "LEMON", "CLOVER",
            "CHERRY", "BELL", "LEMON", "BELL", "CLOVER", "GEM", "CLOVER", "LEMON", "GEM", "SEVEN", "CHERRY", "BELL", "GEM",
            "BELL", "LEMON", "CHERRY", "BELL", "CHERRY", "CHERRY", "BONUS", "LEMON", "CHERRY", "SCATTER", "CLOVER"};
    private static final String[] STRIP_B = {"SEVEN", "LEMON", "CLOVER", "LEMON", "WILD", "CHERRY", "LEMON", "CLOVER",
            "CHERRY", "BELL", "LEMON", "BELL", "CLOVER", "GEM", "CLOVER", "LEMON", "GEM", "SEVEN", "CHERRY", "BELL", "GEM",
            "BELL", "LEMON", "CHERRY", "BELL", "CHERRY", "CHERRY", "SCATTER", "LEMON", "CHERRY", "WILD", "CLOVER"};
    private static final String[] STRIP_C = {"WILD", "LEMON", "CLOVER", "LEMON", "MULT", "CHERRY", "LEMON", "CLOVER",
            "CHERRY", "BELL", "LEMON", "BELL", "GEM", "GEM", "CLOVER", "BELL", "GEM", "SEVEN", "CHERRY", "BELL", "SEVEN",
            "CLOVER", "LEMON", "CHERRY", "BELL", "CHERRY", "CHERRY", "BONUS", "LEMON", "CHERRY", "SCATTER", "CLOVER"};

    private static final int[][] LINES = {
            {1, 1, 1, 1, 1}, {0, 0, 0, 0, 0}, {2, 2, 2, 2, 2}, {0, 1, 2, 1, 0}, {2, 1, 0, 1, 2},
            {0, 0, 1, 2, 2}, {2, 2, 1, 0, 0}, {1, 0, 0, 0, 1}, {1, 2, 2, 2, 1}, {1, 0, 1, 2, 1}};

    public static final List<Reel> REELS = List.of(reel(0, STRIP_A), reel(1, STRIP_B), reel(2, STRIP_C),
            reel(3, STRIP_B), reel(4, STRIP_A));

    public static final Paytable PAYTABLE = new Paytable(SYMBOLS,
            java.util.stream.IntStream.range(0, LINES.length).mapToObj(i -> new Payline(i + 1, LINES[i])).toList(),
            Map.of(3, 2, 4, 10, 5, 50), 10, 3);

    private static Reel reel(int index, String[] strip) {
        return new Reel(index, Arrays.stream(strip).map(SYMBOLS::get).toList());
    }

    private SlotMachine() {}

    public static int paylineCount() {
        return LINES.length;
    }

    public static Symbol symbol(String id) {
        return SYMBOLS.get(id);
    }

    public static Map<String, Symbol> symbols() {
        return SYMBOLS;
    }

    public static int[][] lines() {
        return LINES;
    }

    public record Outcome(int[] stops, Symbol[][] grid, SpinPayout payout) {}

    /** One spin: the grid comes entirely from the provably-fair RNG. */
    public static Outcome spin(ProvablyFairRNG rng, long betPerLine) {
        int[] stops = rng.generateStops(REELS);
        Symbol[][] grid = ProvablyFairRNG.matrixFor(stops, ROWS, REELS);
        return new Outcome(stops, grid, PAYTABLE.calculatePayout(grid, betPerLine));
    }
}
