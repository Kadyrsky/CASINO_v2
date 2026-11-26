import { createRoot, createSignal, onCleanup } from 'solid-js';
import { get } from '../api/client';
import {
  idleMeter,
  isFresh,
  receive,
  spinEnd,
  spinStart,
  type Effect,
  type JackpotWin,
  type Meter,
  type PoolState,
  type SpinJackpot,
  type Update,
} from './jackpotMeter';
import { hub, type HubMessage } from './ws';

/** GET /api/slots/jackpot */
interface JackpotView extends PoolState {
  seed: number;
  contributionPercent: number;
  lastWin: JackpotWin | null;
}

/** How long someone else's hit shows, on the meter and in the alert on other pages. */
export const MOMENT_MS = 7000;

/**
 * The casino-wide jackpot, live: one store for the page, fed by GET /api/slots/jackpot, the "jackpot" WebSocket topic
 * (only while a component that shows it is mounted, see use()) and the player's own spins. The logic is jackpotMeter.ts.
 */
export const jackpot = createRoot(() => {
  let meter: Meter = idleMeter;
  let n = 0;
  let momentTimer: number | undefined;
  const [pool, setPool] = createSignal<PoolState | null>(null);
  const [rules, setRules] = createSignal<{ seed: number; contributionPercent: number } | null>(null);
  const [lastWin, setLastWin] = createSignal<JackpotWin | null>(null);
  /** The latest gain, numbered so the same amount twice still pulses twice. */
  const [gain, setGain] = createSignal<{ by: number; n: number } | null>(null);
  /** Someone else just won: the pool they won (and, once known, who and how much). */
  const [moment, setMoment] = createSignal<{ previous: PoolState; win: JackpotWin | null; n: number } | null>(null);
  /** This player just won. */
  const [celebration, setCelebration] = createSignal<{ amount: number; generation: number; n: number } | null>(null);

  const noteWin = (w: JackpotWin | null | undefined) => {
    if (w && (lastWin()?.generation ?? 0) < w.generation) setLastWin(w);
  };

  const run = ([next, effects]: [Meter, Effect[]]) => {
    meter = next;
    setPool(next.pool);
    for (const e of effects) {
      if (e.kind === 'grew') setGain({ by: e.by, n: ++n });
      else if (e.kind === 'mine') setCelebration({ amount: e.amount, generation: e.generation, n: ++n });
      else if (e.kind === 'hit') {
        setMoment({ previous: e.previous, win: e.win, n: ++n });
        window.clearTimeout(momentTimer);
        momentTimer = window.setTimeout(() => setMoment(null), MOMENT_MS);
      } else {
        const m = moment();
        if (m && m.previous.generation === e.win.generation) setMoment({ ...m, win: e.win });
      }
    }
  };
  const update = (u: Update) => {
    const [next, effects] = receive(meter, u);
    if (next.held.length === meter.held.length) noteWin(u.win); // unless held back during the player's spin
    run([next, effects]);
  };

  let loadedAt = 0;
  const load = async () => {
    loadedAt = Date.now();
    try {
      const v = await get<JackpotView>('/api/slots/jackpot');
      setRules({ seed: v.seed, contributionPercent: v.contributionPercent });
      update({ pool: { amount: v.amount, generation: v.generation }, win: v.lastWin, live: false });
    } catch {
      // shown as unknown until the next tick
    }
  };

  const onMessage = (msg: HubMessage) => {
    // Subscribed again after a reconnect: catch up (the first time, use() has just asked).
    if (msg.type === 'SUBSCRIBED') {
      if (Date.now() - loadedAt > 3000) void load();
      return;
    }
    if (msg.type !== 'JACKPOT' && msg.type !== 'JACKPOT_WON') return;
    const d = msg.data as PoolState & { lastWin?: JackpotWin };
    update({ pool: { amount: d.amount, generation: d.generation }, win: d.lastWin ?? null, live: isFresh(msg.ts, Date.now()) });
  };

  let users = 0;
  let off: (() => void) | undefined;
  let poll: number | undefined;

  return {
    pool,
    rules,
    lastWin,
    gain,
    moment,
    celebration,
    /** Keeps the jackpot live while the calling component is mounted. */
    use() {
      if (users++ === 0) {
        off = hub.subscribe('jackpot', onMessage);
        void load();
        // Without a socket (blocked, reconnecting), ask now and then instead.
        poll = window.setInterval(() => {
          if (hub.status() !== 'open') void load();
        }, 15_000);
      }
      onCleanup(() => {
        if (--users > 0) return;
        off?.();
        window.clearInterval(poll);
      });
    },
    /** Around the player's own spin, so a hit isn't given away (or shown as someone else's) before the reels stop. */
    spinStarted() {
      meter = spinStart(meter);
    },
    spinEnded(spin: SpinJackpot | null) {
      for (const u of meter.held) noteWin(u.win);
      run(spinEnd(meter, spin));
    },
    dismissCelebration() {
      setCelebration(null);
    },
  };
});
