package win.naebka.slots;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/** Symbol rules, paylines and the scatter/bonus rules of a machine. */
public record Paytable(Map<String, Symbol> symbolRules, List<Payline> paylines, Map<Integer, Integer> scatterPays,
                       int freeSpinsPerTrigger, int bonusSymbolsNeeded) {

    public Symbol wild() {
        return symbolRules.get("WILD");
    }

    /**
     * @param betPerLine minor units per line; total bet = betPerLine × paylines.size()
     */
    public SpinPayout calculatePayout(Symbol[][] grid, long betPerLine) {
        List<WinningLineResult> lines = new ArrayList<>();
        long lineWin = 0;
        boolean jackpot = false;
        for (Payline payline : paylines) {
            WinningLineResult r = payline.evaluate(grid, wild());
            if (r == null) {
                continue;
            }
            if (r.jackpot()) {
                jackpot = true; // paid from the progressive pool instead of the line multiplier
            } else {
                lineWin += r.lineMultiplier() * betPerLine;
            }
            lines.add(r);
        }
        int scatters = 0;
        int bonuses = 0;
        for (Symbol[] column : grid) {
            for (Symbol s : column) {
                scatters += s.isScatter() ? 1 : 0;
                bonuses += s.isBonus() ? 1 : 0;
            }
        }
        long totalBet = betPerLine * paylines.size();
        long scatterWin = scatterPays.getOrDefault(Math.min(scatters, 5), 0) * totalBet;
        int freeSpins = scatters >= 3 ? freeSpinsPerTrigger : 0;
        boolean bonus = bonuses >= bonusSymbolsNeeded;
        return new SpinPayout(lineWin + scatterWin, lines, lineWin, scatterWin, scatters, bonuses, bonus, freeSpins,
                jackpot);
    }
}
