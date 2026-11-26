import { createEffect, createMemo, createSignal, For, Index, on, onCleanup, onMount, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import { ago, tokens } from '../lib/format';
import { jackpot } from '../lib/jackpot';
import { countUp, odometerCells, wheelTarget } from '../lib/jackpotMeter';
import { Button } from './ui';
import './jackpot.css';

/** How long a wheel takes to roll (jackpot.css); ticks come at most every 500 ms. */
const ROLL_MS = 450;
const COUNT_MS = 2600;
const STRIP = [...'01234567890123456789'];

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** One digit of the odometer: rolls forward to the next digit, and settles on the first strip once there. */
function Wheel(props: { digit: number; rising: boolean }) {
  let strip: HTMLSpanElement | undefined;
  let pos = props.digit; // where the strip points (0–19)
  let settle: number | undefined;
  const place = (at: number, roll: boolean) => {
    pos = at;
    if (!strip) return;
    strip.style.transition = roll ? '' : 'none';
    strip.style.transform = `translateY(calc(${-at} * var(--jp-cell)))`;
    if (!roll) void strip.offsetHeight; // apply it before any roll that follows
  };
  onMount(() => place(pos, false));
  createEffect(
    on(
      () => props.digit,
      (digit) => {
        window.clearTimeout(settle);
        if (pos > 9) place(pos - 10, false); // the last roll hasn't settled yet
        if (digit === pos) return;
        const reduced = reducedMotion();
        const target = reduced ? digit : wheelTarget(pos, digit, props.rising);
        place(target, !reduced);
        if (target > 9) settle = window.setTimeout(() => place(digit, false), ROLL_MS + 50);
      },
      { defer: true },
    ),
  );
  onCleanup(() => window.clearTimeout(settle));
  return (
    <span class="jp-wheel">
      <span ref={(el) => (strip = el)} class="jp-strip">
        <For each={STRIP}>{(d) => <span>{d}</span>}</For>
      </span>
    </span>
  );
}

/** The amount as wheels that roll when it changes (forward as it grows, back when a new pool starts). */
export function Odometer(props: { value: number }) {
  const cells = createMemo(() => odometerCells(props.value));
  const trend = createMemo<{ value: number; rising: boolean }>((prev) => ({ value: props.value, rising: props.value >= prev.value }), {
    value: props.value,
    rising: true,
  });
  return (
    <>
      <span class="sr-only">{tokens(props.value)}</span>
      <span class="jp-odometer" aria-hidden="true">
        <Index each={cells()}>
          {(cell) => {
            // Counted from the right, a place is always a digit or always a mark (odometerCells).
            const first = cell();
            return 'digit' in first ? (
              <Wheel digit={(cell() as { digit: number }).digit} rising={trend().rising} />
            ) : (
              <span>{first.mark}</span>
            );
          }}
        </Index>
      </span>
    </>
  );
}

/** Coins flying out from the middle of the nearest positioned box. */
function Burst(props: { count: number; spread: number; size?: number; duration?: number }) {
  const coins = Array.from({ length: props.count }, (_, i) => {
    const angle = (i / props.count) * Math.PI * 2 + Math.random() * 0.6;
    const dist = props.spread * (0.55 + Math.random() * 0.45);
    const size = (props.size ?? 8) * (0.7 + Math.random() * 0.6);
    return {
      '--dx': `${Math.round(Math.cos(angle) * dist)}px`,
      '--dy': `${Math.round(Math.sin(angle) * dist * 0.8)}px`,
      '--delay': `${Math.round(Math.random() * 220)}ms`,
      '--spin': `${Math.round(Math.random() * 540 - 270)}deg`,
      '--jp-fly': `${props.duration ?? 1300}ms`,
      width: `${size}px`,
      height: `${size}px`,
    };
  });
  return (
    <span class="pointer-events-none absolute inset-0" aria-hidden="true">
      <For each={coins}>{(style) => <span class="jp-coin" style={style} />}</For>
    </span>
  );
}

/**
 * The casino-wide jackpot on the slots page: it rolls up as anyone loses a spin, and when someone else hits it, it
 * holds the pool they won for a moment, with their (masked) name, before rolling down to the new pool.
 */
export function JackpotMeter() {
  jackpot.use();
  const moment = jackpot.moment;
  const shown = () => {
    const m = moment();
    return m ? (m.win?.amount ?? m.previous.amount) : (jackpot.pool()?.amount ?? null);
  };
  const bursts = createMemo(() => {
    const m = moment();
    return m ? [m.n] : [];
  });
  const [pulse, setPulse] = createSignal(0);
  const [gains, setGains] = createSignal<{ by: number; n: number }[]>([]);
  createEffect(
    on(
      jackpot.gain,
      (g) => {
        if (!g || moment()) return;
        setPulse(g.n);
        setGains((list) => [...list.slice(-2), g]);
        window.setTimeout(() => setGains((list) => list.filter((x) => x.n !== g.n)), 1400);
      },
      { defer: true },
    ),
  );
  const rules = () => {
    const r = jackpot.rules();
    return r
      ? `One pool for the whole casino: every losing spin, by anyone, adds ${r.contributionPercent}% of what it lost. Five wilds on a line win all of it, and the next pool starts at ${tokens(r.seed)} NTK.`
      : 'One pool for the whole casino, fed by every losing spin.';
  };
  // "last won 3 minutes ago" moves on by itself.
  const [now, setNow] = createSignal(Date.now());
  const clock = window.setInterval(() => setNow(Date.now()), 30_000);
  onCleanup(() => window.clearInterval(clock));
  const winner = () => {
    const m = moment();
    return m ? (m.win ? `Won by ${m.win.winner}!` : 'Someone just won it!') : '';
  };
  const subtitle = () => {
    if (moment()) return winner();
    const r = jackpot.rules();
    const last = jackpot.lastWin();
    const grows = r ? `+${r.contributionPercent}% of every losing spin` : 'Grows with every losing spin';
    return last && now() ? `${grows} · last won ${ago(last.at)}` : grows;
  };
  return (
    <div class="relative">
      <div
        class={`jp-meter min-w-56 rounded-xl border bg-gradient-to-r to-transparent px-4 py-2 ${
          moment() ? 'jp-hit border-gold-300/70 from-gold-500/25' : 'border-gold-500/30 from-gold-500/15'
        }`}
        title={rules()}
      >
        <p class="dl-type flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-gold-300">
          <span aria-hidden="true">✦</span>
          {moment() ? 'Jackpot hit!' : 'Casino jackpot'}
        </p>
        <p class="flex items-baseline gap-1.5 text-2xl font-black text-gold-300 tabular">
          <Show when={shown() != null} fallback={<span class="text-ink-500">–</span>}>
            <span class={`jp-amount ${pulse() ? (pulse() % 2 ? 'jp-grew-a' : 'jp-grew-b') : ''}`}>
              <Odometer value={shown() ?? 0} />
            </span>
          </Show>
          <span class="text-sm">NTK</span>
        </p>
        <p class="text-[11px] text-ink-400">{subtitle()}</p>
      </div>
      {/* Screen readers hear about a hit, not every tick. */}
      <span class="sr-only" role="status">
        {moment() ? `Jackpot hit! ${winner()}` : ''}
      </span>
      <For each={gains()}>
        {(g) => <span class="jp-gain pointer-events-none absolute right-3 top-5 text-xs font-bold text-gold-300">+{tokens(g.by)}</span>}
      </For>
      {/* One burst per hit (not again when the winner's name comes in). */}
      <For each={bursts()}>{() => <Burst count={16} spread={130} duration={1400} />}</For>
    </div>
  );
}

/** Under a spin's result: what a losing spin added to the jackpot. */
export function AddedToJackpot(props: { added: number }) {
  return <span class="text-xs text-gold-300">+{tokens(props.added)} to the jackpot</span>;
}

function Celebration(props: { amount: number; wild: string; onClose: () => void }) {
  const reduced = reducedMotion();
  const [count, setCount] = createSignal(reduced ? props.amount : 0);
  let collect: HTMLButtonElement | undefined;
  onMount(() => {
    collect?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose();
    document.addEventListener('keydown', onKey);
    const close = window.setTimeout(props.onClose, 15_000);
    let frame = 0;
    if (!reduced) {
      const start = performance.now() + 500; // once the title has landed
      const step = (now: number) => {
        setCount(countUp(props.amount, now - start, COUNT_MS));
        if (now - start < COUNT_MS) frame = requestAnimationFrame(step);
      };
      frame = requestAnimationFrame(step);
    }
    onCleanup(() => {
      document.removeEventListener('keydown', onKey);
      window.clearTimeout(close);
      cancelAnimationFrame(frame);
    });
  });
  const spread = Math.min(window.innerWidth, window.innerHeight) * 0.45;
  return (
    <Portal>
      <div
        class="jp-overlay fixed inset-0 z-[70] grid place-items-center overflow-hidden bg-ink-950/85 p-6 backdrop-blur-sm"
        role="dialog"
        aria-modal="true"
        aria-label={`Jackpot! You won ${tokens(props.amount)} NTK`}
        onClick={props.onClose}
      >
        <div class="jp-rays pointer-events-none absolute left-1/2 top-1/2 size-[170vmax] -translate-x-1/2 -translate-y-1/2" aria-hidden="true" />
        <Burst count={30} spread={spread} size={12} duration={1800} />
        <div class="relative flex flex-col items-center gap-3 text-center" onClick={(e) => e.stopPropagation()}>
          <p class="jp-title dl-type text-6xl font-black tracking-tight sm:text-8xl">Jackpot!</p>
          <p class="text-sm font-semibold uppercase tracking-widest text-gold-300">Five {props.wild}s on a line</p>
          <p class="tabular text-4xl font-black text-ink-100 sm:text-5xl" aria-hidden="true">
            +{tokens(count())} <span class="text-xl text-gold-300">NTK</span>
          </p>
          <p class="max-w-sm text-sm text-ink-400">The whole casino's jackpot is yours. A new pool has started for everyone else.</p>
          <Button ref={(el) => (collect = el)} size="lg" class="mt-2 min-w-40" onClick={props.onClose}>
            Collect
          </Button>
        </div>
      </div>
    </Portal>
  );
}

/** The player's own hit: a full-screen celebration (the "jackpot" sound plays with the result, see Slots.tsx). */
export function JackpotCelebration(props: { wild: string }) {
  return (
    <Show when={jackpot.celebration()} keyed>
      {(won) => <Celebration amount={won.amount} wild={props.wild} onClose={() => jackpot.dismissCelebration()} />}
    </Show>
  );
}
