import { createEffect, createSignal, For, on, onCleanup, Show } from 'solid-js';
import type { Market, Match, MatchState, Selection } from '../api/types';
import { clock, compact, humanize, odds } from '../lib/format';
import { Badge, statusTone } from './ui';

export const SIDE_COLOR = { 1: 'text-amber-team', 2: 'text-sapphire-team' } as const;
export const SIDE_BG = { 1: 'bg-amber-team', 2: 'bg-sapphire-team' } as const;

/** Elapsed game clock that keeps ticking locally between watcher snapshots. */
export function useMatchClock(match: () => Match | undefined) {
  const [now, setNow] = createSignal(Date.now());
  const [base, setBase] = createSignal({ elapsed: 0, at: Date.now() });
  createEffect(
    on(
      () => match()?.state.elapsed_s,
      (elapsed) => setBase({ elapsed: elapsed ?? 0, at: Date.now() }),
    ),
  );
  const timer = window.setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => window.clearInterval(timer));
  return () => {
    const m = match();
    if (!m || m.status !== 'LIVE') return base().elapsed;
    return base().elapsed + Math.floor((now() - base().at) / 1000);
  };
}

export function StatusBadge(props: { status: string }) {
  return (
    <Badge tone={statusTone(props.status)} pulse={props.status === 'LIVE'}>
      {props.status === 'STALE' ? 'Data delayed' : humanize(props.status)}
    </Badge>
  );
}

/** Net-worth tug-of-war bar: amber share on the left, sapphire on the right. */
export function NetWorthBar(props: { state: Partial<MatchState> }) {
  const share = () => {
    const [a, b] = props.state.net_worth ?? [1, 1];
    return a + b === 0 ? 50 : (a / (a + b)) * 100;
  };
  return (
    <div class="relative h-1.5 overflow-hidden rounded-full bg-sapphire-team/70">
      <div class="absolute inset-y-0 left-0 rounded-full bg-amber-team transition-[width] duration-700" style={{ width: `${share()}%` }} />
      <div class="absolute inset-y-0 left-1/2 w-px bg-ink-950/70" />
    </div>
  );
}

export function ObjectivePips(props: { alive: number; side: 1 | 2; total?: number }) {
  const total = () => props.total ?? 16;
  return (
    <div class={`flex flex-wrap gap-0.5 ${props.side === 2 ? 'justify-end' : ''}`} aria-label={`${props.alive} of ${total()} objectives standing`}>
      <For each={Array.from({ length: total() }, (_, i) => i)}>
        {(i) => (
          <span
            class={`h-2.5 w-1.5 rounded-sm transition-colors ${i < props.alive ? SIDE_BG[props.side] : 'bg-ink-700'}`}
          />
        )}
      </For>
    </div>
  );
}

/** One price button. Flashes green/red when the price moves. */
export function OddsButton(props: {
  selection: Selection;
  market: Market;
  selected?: boolean;
  onPick: (s: Selection, m: Market) => void;
  compact?: boolean;
}) {
  const [move, setMove] = createSignal<'up' | 'down' | null>(null);
  createEffect(
    on(
      () => props.selection.odds,
      (now, prev) => {
        if (prev == null || now == null || now === prev) return;
        setMove(now > prev ? 'up' : 'down');
        const t = window.setTimeout(() => setMove(null), 1200);
        onCleanup(() => window.clearTimeout(t));
      },
    ),
  );
  const open = () => props.market.status === 'OPEN' && props.selection.odds != null;
  return (
    <button
      disabled={!open()}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        props.onPick(props.selection, props.market);
      }}
      class={`group flex flex-1 items-center justify-between gap-2 rounded-lg border px-3 transition-all ${props.compact ? 'h-9' : 'h-12'} ${
        props.selected
          ? 'border-gold-500 bg-gold-500/15'
          : 'border-ink-700 bg-ink-850 hover:border-ink-500 hover:bg-ink-800'
      } disabled:cursor-not-allowed disabled:opacity-50 ${move() === 'up' ? 'animate-flash-up' : move() === 'down' ? 'animate-flash-down' : ''}`}
      aria-label={`${props.selection.name} at ${odds(props.selection.odds)}`}
    >
      <span class="truncate text-xs font-medium text-ink-300 group-hover:text-ink-100">{props.selection.name}</span>
      <span class="tabular flex items-center gap-1 font-bold text-gold-300">
        <Show when={move()}>
          <span class={`text-[10px] ${move() === 'up' ? 'text-win' : 'text-loss'}`}>{move() === 'up' ? '▲' : '▼'}</span>
        </Show>
        <Show when={open()} fallback={<span class="text-ink-500">🔒</span>}>
          {odds(props.selection.odds)}
        </Show>
      </span>
    </button>
  );
}

export function suspendLabel(reason: string | null): string {
  switch (reason) {
    case 'AWAITING_PRICE':
      return 'Waiting for the first price';
    case 'objective.destroyed':
      return 'Objective destroyed — repricing';
    case 'networth.swing':
      return 'Big swing — repricing';
    case 'STALE':
    case 'match.stale':
      return 'Live data delayed — suspended for safety';
    case 'PLAUSIBILITY':
      return 'Prices under review';
    case 'OUTCOME_DECIDED':
      return 'Outcome already decided';
    default:
      return reason ? humanize(reason) : 'Suspended';
  }
}

export function TeamLine(props: { match: Match; side: 1 | 2; elapsed?: number }) {
  const team = () => props.match.teams.find((t) => t.side === props.side);
  const idx = () => props.side - 1;
  return (
    <div class={`flex flex-col gap-1 ${props.side === 2 ? 'items-end text-right' : ''}`}>
      <span class={`text-sm font-bold ${SIDE_COLOR[props.side]}`}>
        {team()?.name}
        <Show when={team()?.isWinner}> 🏆</Show>
      </span>
      <span class="tabular text-xs text-ink-400">
        {compact(props.match.state.net_worth?.[idx()])} souls · {props.match.state.objectives_alive?.[idx()] ?? '–'} obj
      </span>
    </div>
  );
}

export function MatchClock(props: { seconds: number }) {
  return <span class="tabular font-mono text-sm font-semibold text-ink-200">{clock(props.seconds)}</span>;
}
