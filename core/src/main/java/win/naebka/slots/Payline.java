package win.naebka.slots;

/**
 * A payline: for each column, which row it passes through. Wins pay left to right only.
 *
 * <p>Evaluation: the line's target is its first non-wild symbol; wilds substitute for it. If the line
 * starts with a run of wilds, that run is also scored as wilds and the better of the two is paid.
 * Scatter and bonus symbols break a line. A MULTIPLIER among the paying symbols doubles the win.
 */
public record Payline(int id, int[] positions) {

    /** @return the win, or null if the line does not pay. */
    public WinningLineResult evaluate(Symbol[][] grid, Symbol wildSymbol) {
        int cols = positions.length;
        Symbol[] line = new Symbol[cols];
        for (int c = 0; c < cols; c++) {
            line[c] = grid[c][positions[c]];
        }
        int wildRun = 0;
        while (wildRun < cols && line[wildRun].isWild()) {
            wildRun++;
        }
        Symbol target = null;
        for (Symbol s : line) {
            if (!s.isWild()) {
                target = s;
                break;
            }
        }
        int targetRun = 0;
        if (target != null && target.type() == SymbolType.REGULAR) {
            while (targetRun < cols && (line[targetRun].isWild() || line[targetRun].id().equals(target.id()))) {
                targetRun++;
            }
        }
        int targetPay = target == null ? 0 : target.getPayoutForCount(targetRun);
        int wildPay = wildSymbol.getPayoutForCount(wildRun);

        Symbol paying;
        int count;
        int multiplier;
        if (wildPay > targetPay) {
            paying = wildSymbol;
            count = wildRun;
            multiplier = wildPay;
        } else if (targetPay > 0) {
            paying = target;
            count = targetRun;
            multiplier = targetPay;
        } else {
            return null;
        }
        boolean doubled = false;
        for (int c = 0; c < count; c++) {
            doubled |= line[c].type() == SymbolType.MULTIPLIER;
        }
        return new WinningLineResult(id, paying, count, doubled ? multiplier * 2 : multiplier,
                count == cols && paying == wildSymbol);
    }
}
