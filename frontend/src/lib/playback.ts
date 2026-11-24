/**
 * The realtime map's playback clock. Frames arrive in bursts (Valve's broadcast comes in ~3 s fragments), so the map
 * plays a few seconds behind the newest frame, on the game clock. Pausing holds the picture; playing on after a pause
 * stays that far behind (like a recorder) until ⏭ Live, as long as the frames are still kept.
 */

/** Seconds behind the newest frame that playback normally runs, so bursts of frames play smoothly. */
export const LAG = 3;
/** Further behind than this without having paused (a background tab, a stalled feed): catch up. */
export const CATCH_UP = 9;

export interface PlayClock {
  /** Game time shown; null before the first frame. */
  time: number | null;
  /** Behind on purpose: paused, or playing on after a pause. Ends with ⏭ Live, or on catching up by itself. */
  held: boolean;
}

/** The clock `dt` seconds later, with frames kept from game time `oldest` to `latest`. */
export function advance(clock: PlayClock, oldest: number, latest: number, dt: number, paused: boolean): PlayClock {
  let held = clock.held || paused;
  let time = clock.time;
  if (time == null || (!held && latest - time > CATCH_UP)) time = Math.max(oldest, latest - LAG);
  // Paused for longer than the frames are kept: the oldest one left.
  time = Math.max(oldest, time);
  if (!paused) {
    time = Math.min(latest, time + dt);
    // Back to the usual distance (the feed stalled while playing on): the normal rules again.
    if (held && latest - time <= LAG) held = false;
  }
  return { time, held };
}

/** Back to live: just behind the newest frame. */
export function liveClock(latest: number): PlayClock {
  return { time: latest - 1, held: false };
}
