/** Building blocks of the live matches page: rank badges, hero icons, rosters and match cards. */
import { A } from '@solidjs/router';
import { createSignal, For, onCleanup, Show } from 'solid-js';
import type { LiveAssets, LiveMatchSummary, LivePlayer } from '../api/types';
import { clock, compact } from '../lib/format';
import { GAME_MODE_LABEL, MODE_LABEL, TEAM_NAMES, TEAM_TEXT, heroOf, rankOf, regionLabel, roman } from '../lib/live';
import { Badge } from './ui';

export function RankBadge(props: { assets?: LiveAssets; badge: number | null | undefined; size?: 'sm' | 'md' | 'lg' }) {
  const rank = () => rankOf(props.assets, props.badge);
  const px = () => ({ sm: 'size-6', md: 'size-8', lg: 'size-11' })[props.size ?? 'sm'];
  return (
    <Show when={rank()} fallback={<span class={`${px()} inline-grid shrink-0 place-items-center rounded-full bg-ink-800 text-[9px] text-ink-500`} title="No rank">–</span>}>
      {(r) => (
        <span class={`relative inline-grid ${px()} shrink-0 place-items-center`} title={r().label}>
          <Show when={r().image} fallback={<span class="text-[10px] font-bold" style={{ color: r().color ?? undefined }}>{r().tier}</span>}>
            {(src) => <img src={src()} alt={r().label} loading="lazy" class="size-full object-contain drop-shadow" />}
          </Show>
          <span class="absolute -bottom-1 -right-1 rounded bg-ink-950/90 px-0.5 text-[8px] font-bold leading-tight text-ink-100">
            {roman(r().subrank)}
          </span>
        </span>
      )}
    </Show>
  );
}

export function HeroIcon(props: { assets?: LiveAssets; heroId: number; class?: string; dim?: boolean }) {
  const hero = () => heroOf(props.assets, props.heroId);
  return (
    <Show
      when={hero()?.icon}
      fallback={<span class={`inline-grid shrink-0 place-items-center rounded-md bg-ink-700 text-[10px] text-ink-400 ${props.class ?? 'size-7'}`}>?</span>}
    >
      {(src) => (
        <img
          src={src()}
          alt={hero()?.name ?? 'Hero'}
          title={hero()?.name ?? undefined}
          loading="lazy"
          class={`shrink-0 rounded-md bg-ink-800 object-cover ${props.dim ? 'opacity-40 grayscale' : ''} ${props.class ?? 'size-7'}`}
        />
      )}
    </Show>
  );
}

export function playerName(p: { name?: string | null; account_id: number }): string {
  return p.name?.trim() || `Player ${p.account_id}`;
}

/** One team's six players: hero, name, rank. */
export function Roster(props: { assets?: LiveAssets; players: LivePlayer[]; team: 0 | 1; dense?: boolean }) {
  const players = () => props.players.filter((p) => p.team === props.team);
  const right = () => props.team === 1;
  return (
    <ul class="flex flex-col gap-0.5">
      <For each={players()}>
        {(p) => (
          <li
            class={`flex items-center gap-2 rounded-md px-1.5 ${props.dense ? 'py-0.5' : 'py-1'} ${right() ? 'flex-row-reverse text-right' : ''} ${props.team === 0 ? 'bg-amber-team/[0.04]' : 'bg-sapphire-team/[0.04]'}`}
          >
            <RankBadge assets={props.assets} badge={p.badge} />
            <HeroIcon assets={props.assets} heroId={p.hero_id} class={props.dense ? 'size-6' : 'size-7'} />
            <span class="min-w-0 flex-1 truncate text-[13px] text-ink-200" title={playerName(p)}>
              {playerName(p)}
            </span>
          </li>
        )}
      </For>
    </ul>
  );
}

/** A clock that keeps ticking between directory refreshes. */
export function useElapsed(startTime: () => number | undefined) {
  const [now, setNow] = createSignal(Date.now());
  const t = window.setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => window.clearInterval(t));
  return () => {
    const s = startTime();
    return s ? Math.max(0, Math.floor(now() / 1000 - s)) : 0;
  };
}

export function liveMatchHref(m: LiveMatchSummary, bettable: Record<string, string> | undefined): string {
  const ours = bettable?.[m.match_id];
  return ours ? `/matches/${ours}` : `/live/${m.match_id}`;
}

/** A card of the "All live matches" grid. */
export function LiveMatchCard(props: { match: LiveMatchSummary; assets?: LiveAssets; bettable?: Record<string, string> }) {
  const elapsed = useElapsed(() => props.match.start_time);
  const m = () => props.match;
  const canBet = () => !!props.bettable?.[m().match_id];
  return (
    <A
      href={liveMatchHref(m(), props.bettable)}
      class={`group flex flex-col gap-3 rounded-[var(--radius-card)] border bg-ink-900/80 p-4 transition-all hover:-translate-y-0.5 hover:border-ink-500 ${canBet() ? 'border-gold-500/40' : 'border-ink-700/70'}`}
    >
      <div class="flex items-center justify-between gap-2">
        <div class="flex min-w-0 items-center gap-2">
          <span class={`text-xs font-bold uppercase tracking-wider ${m().match_mode === 'ranked' ? 'text-gold-300' : 'text-ink-300'}`}>
            {MODE_LABEL[m().match_mode]}
          </span>
          <Show when={m().game_mode !== 'normal'}>
            <Badge tone="neutral">{GAME_MODE_LABEL[m().game_mode]}</Badge>
          </Show>
          <span class="truncate text-xs text-ink-500">· {regionLabel(m().region)}</span>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <Show when={canBet()}>
            <Badge tone="gold">Bet</Badge>
          </Show>
          <span class="tabular font-mono text-sm font-semibold text-ink-100">{clock(elapsed())}</span>
        </div>
      </div>

      <div class="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
        <div class="flex items-center gap-2">
          <RankBadge assets={props.assets} badge={m().team_badges[0]} size="md" />
          <span class={`text-sm font-bold ${TEAM_TEXT[0]}`}>{TEAM_NAMES[0]}</span>
        </div>
        <span class="tabular text-center text-xs font-semibold text-ink-300">
          {compact(m().net_worth[0])} : {compact(m().net_worth[1])}
        </span>
        <div class="flex items-center justify-end gap-2">
          <span class={`text-sm font-bold ${TEAM_TEXT[1]}`}>{TEAM_NAMES[1]}</span>
          <RankBadge assets={props.assets} badge={m().team_badges[1]} size="md" />
        </div>
      </div>

      <div class="grid grid-cols-2 gap-2">
        <Roster assets={props.assets} players={m().players} team={0} dense />
        <Roster assets={props.assets} players={m().players} team={1} dense />
      </div>

      <div class="flex items-center justify-between text-[11px] text-ink-500">
        <span>👁 {m().spectators} watching</span>
        <span class="text-ink-400 group-hover:text-gold-300">{canBet() ? 'Bet and watch live →' : 'Live map →'}</span>
      </div>
    </A>
  );
}
