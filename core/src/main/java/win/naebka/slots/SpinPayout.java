package win.naebka.slots;

import java.util.List;

/** Everything a grid pays, in minor units (excluding the progressive jackpot amount itself). */
public record SpinPayout(long totalWin, List<WinningLineResult> winningLines, long lineWin, long scatterWin,
                         int scatterCount, int bonusCount, boolean bonusTriggered, int freeSpinsAwarded,
                         boolean jackpotHit) {}
