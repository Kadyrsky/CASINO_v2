package win.naebka.slots;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Random;
import org.junit.jupiter.api.Test;

class SlotMachineTest {

    static Symbol[][] grid(String... columns) {
        Symbol[][] g = new Symbol[columns.length][];
        for (int c = 0; c < columns.length; c++) {
            String[] ids = columns[c].split(",");
            g[c] = new Symbol[ids.length];
            for (int r = 0; r < ids.length; r++) {
                g[c][r] = SlotMachine.symbol(ids[r]);
            }
        }
        return g;
    }

    @Test
    void middleLineOfSevensPays() {
        Symbol[][] g = grid("LEMON,SEVEN,CHERRY", "LEMON,SEVEN,CHERRY", "BELL,SEVEN,GEM", "CLOVER,LEMON,GEM", "BELL,CHERRY,GEM");
        SpinPayout p = SlotMachine.PAYTABLE.calculatePayout(g, 10);
        assertThat(p.winningLines()).anySatisfy(l -> {
            assertThat(l.paylineId()).isEqualTo(1);
            assertThat(l.winningSymbol().id()).isEqualTo("SEVEN");
            assertThat(l.symbolCount()).isEqualTo(3);
        });
        assertThat(p.lineWin()).isGreaterThanOrEqualTo(40 * 10);
    }

    @Test
    void wildSubstitutesAndMultiplierDoublesTheLine() {
        Symbol[][] g = grid("CHERRY,GEM,LEMON", "BELL,WILD,LEMON", "BELL,MULT,CLOVER", "CHERRY,GEM,LEMON", "LEMON,BELL,CHERRY");
        SpinPayout p = SlotMachine.PAYTABLE.calculatePayout(g, 1);
        var middle = p.winningLines().stream().filter(l -> l.paylineId() == 1).findFirst().orElseThrow();
        assertThat(middle.winningSymbol().id()).isEqualTo("GEM");
        assertThat(middle.symbolCount()).isEqualTo(4);
        assertThat(middle.lineMultiplier()).isEqualTo(75 * 2);
    }

    @Test
    void scattersPayAnywhereAndAwardFreeSpins() {
        Symbol[][] g = grid("SCATTER,LEMON,BELL", "CHERRY,LEMON,SCATTER", "GEM,BELL,CLOVER", "SCATTER,GEM,LEMON", "BELL,CHERRY,GEM");
        SpinPayout p = SlotMachine.PAYTABLE.calculatePayout(g, 2);
        assertThat(p.scatterCount()).isEqualTo(3);
        assertThat(p.freeSpinsAwarded()).isEqualTo(10);
        assertThat(p.scatterWin()).isEqualTo(2 * 2 * 10);
    }

    @Test
    void fiveWildsOnALineHitTheJackpot() {
        Symbol[][] g = grid("CHERRY,WILD,LEMON", "BELL,WILD,LEMON", "BELL,WILD,CLOVER", "CHERRY,WILD,LEMON", "LEMON,WILD,CHERRY");
        assertThat(SlotMachine.PAYTABLE.calculatePayout(g, 1).jackpotHit()).isTrue();
    }

    @Test
    void sameSeedsReproduceTheSameSpinAndOthersDoNot() {
        ProvablyFairRNG rng = new ProvablyFairRNG("server", "client", 7);
        Symbol[][] g = rng.generateSpinMatrix(SlotMachine.ROWS, SlotMachine.REELS);
        assertThat(ProvablyFairRNG.verifyResult("server", "client", 7, g, SlotMachine.ROWS, SlotMachine.REELS)).isTrue();
        assertThat(ProvablyFairRNG.verifyResult("server", "client", 8, g, SlotMachine.ROWS, SlotMachine.REELS)).isFalse();
    }

    @Test
    void floatsAreUniformEnough() {
        double[] f = new ProvablyFairRNG("s", "c", 1).floats(10_000);
        double mean = java.util.Arrays.stream(f).average().orElseThrow();
        assertThat(mean).isBetween(0.48, 0.52);
        assertThat(java.util.Arrays.stream(f).allMatch(x -> x >= 0 && x < 1)).isTrue();
    }

    /** Monte-Carlo RTP including free spins and the pick bonus (jackpot excluded: it is funded separately). */
    @Test
    void returnToPlayerIsBetween93And98Percent() {
        Random random = new Random(1);
        long betPerLine = 10;
        long staked = 0;
        long returned = 0;
        int freeSpins = 0;
        int paidSpins = 0;
        while (paidSpins < 400_000) {
            boolean free = freeSpins > 0;
            if (free) {
                freeSpins--;
            } else {
                paidSpins++;
                staked += betPerLine * SlotMachine.paylineCount();
            }
            ProvablyFairRNG rng = new ProvablyFairRNG(Long.toHexString(random.nextLong()), "c", paidSpins);
            SpinPayout p = SlotMachine.spin(rng, betPerLine).payout();
            returned += p.totalWin();
            freeSpins += p.freeSpinsAwarded();
            if (p.bonusTriggered()) {
                double[] f = rng.floats(16);
                PickAndClickBonus bonus = PickAndClickBonus.create(null, betPerLine * SlotMachine.paylineCount(),
                        java.util.Arrays.copyOfRange(f, 5, 16));
                for (int i = 0; i < PickAndClickBonus.PICKS; i++) {
                    bonus.playTurn(i);
                }
                returned += bonus.totalBonusWin();
            }
        }
        double rtp = (double) returned / staked;
        assertThat(rtp).isBetween(0.93, 0.98);
    }
}
