package win.naebka.slots;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import win.naebka.slots.JackpotService.Pool;

class JackpotServiceTest {
    /**
     * A seed pair whose spin lands five Hidden Kings on line 5 and wins nothing else, found by trying nonces in order
     * (about one spin in 840,000 hits the jackpot). JackpotIT gives it to players so their next spin hits.
     */
    static final String SERVER_SEED = "naebka-jackpot-it";
    static final String CLIENT_SEED = "five-hidden-kings";
    static final long NONCE = 1_371_361;

    static SpinPayout payout(long totalWin, boolean bonus, boolean jackpot) {
        return new SpinPayout(totalWin, List.of(), totalWin, 0, 0, bonus ? 3 : 0, bonus, 0, jackpot);
    }

    @Test
    void theTestSeedHitsTheJackpotAndWinsNothingElse() {
        SpinPayout p = SlotMachine.spin(new ProvablyFairRNG(SERVER_SEED, CLIENT_SEED, NONCE), 10).payout();
        assertThat(p.jackpotHit()).isTrue();
        assertThat(p.totalWin()).isZero();
        assertThat(p.winningLines()).singleElement().satisfies(l -> assertThat(l.paylineId()).isEqualTo(5));
    }

    @Test
    void aPaidSpinLosesItsStakeMinusWhatItWon() {
        assertThat(JackpotService.lossOf(payout(0, false, false), 100, false)).isEqualTo(100);
        assertThat(JackpotService.lossOf(payout(40, false, false), 100, false)).isEqualTo(60);
        assertThat(JackpotService.lossOf(payout(100, false, false), 100, false)).isZero();
        assertThat(JackpotService.lossOf(payout(880, false, false), 100, false)).isZero();
    }

    @Test
    void freeSpinsJackpotHitsAndRiftBonusesLoseNothing() {
        assertThat(JackpotService.lossOf(payout(0, false, false), 100, true)).isZero();
        assertThat(JackpotService.lossOf(payout(0, false, true), 100, false)).isZero();
        assertThat(JackpotService.lossOf(payout(0, true, false), 100, false)).isZero();
    }

    @Test
    void winnersAreShownByTheirFirstAndLastLetter() {
        assertThat(JackpotService.maskName("lucky_seven")).isEqualTo("l***n");
        assertThat(JackpotService.maskName("  bo ")).isEqualTo("b***");
        assertThat(JackpotService.maskName("ž")).isEqualTo("ž***");
        assertThat(JackpotService.maskName(null)).isEqualTo("someone");
    }

    @Test
    void aLaterPoolOrAFullerOneIsNewer() {
        UUID game = UUID.randomUUID();
        Pool small = new Pool(game, 500_100, 500_000, 200, 3);
        Pool big = new Pool(game, 500_200, 500_000, 200, 3);
        Pool next = new Pool(game, 500_000, 500_000, 200, 4);
        assertThat(JackpotFeed.newer(small, big)).isSameAs(big);
        assertThat(JackpotFeed.newer(big, small)).isSameAs(big);
        assertThat(JackpotFeed.newer(big, next)).isSameAs(next);
        assertThat(JackpotFeed.newer(next, big)).isSameAs(next);
    }
}
