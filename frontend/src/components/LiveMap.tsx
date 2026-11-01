/**
 * Realtime map of a live Deadlock match: hero positions, health, levels, items, objectives and events, from the
 * Steam bot's broadcast frames (WebSocket topic watch:{deadlockMatchId}).
 *
 * Frames arrive in bursts (Valve's broadcast comes in ~3 s fragments, sampled twice a second), so they are played back
 * on a game clock and positions are interpolated between frames. The data is about 25 s behind the real game.
 */
import { A } from '@solidjs/router';
import { createQuery } from '@tanstack/solid-query';
import { createMemo, createSignal, For, Index, onCleanup, Show } from 'solid-js';
import { get } from '../api/client';
import type { FrameEvent, FrameObjective, FramePlayer, LiveAssets, LiveFrame, LiveMatchInfo, LivePlayer } from '../api/types';
import { auth } from '../lib/auth';
import { clock, compact, tokens } from '../lib/format';
import { TEAM_COLOR, TEAM_NAMES, TEAM_TEXT, heroOf, itemOf, toMap, useLiveAssets } from '../lib/live';
import { useTopic } from '../lib/ws';
import { HeroIcon, RankBadge, playerName } from './live';
import { Badge, Button, Card, Spinner, Tabs } from './ui';

const KEEP_FRAMES = 160; // ~80 s at 2 frames per second
const MAX_EVENTS = 80;

interface View {
  frame: LiveFrame;
  time: number;
  pos: Map<number, [number, number]>;
}

function frameTime(f: LiveFrame): number {
  return f.game_time_s ?? f.tick / 64;
}

/** Playback of buffered frames on a game clock, with positions interpolated between neighbours. */
function usePlayback() {
  const frames: LiveFrame[] = [];
  const [view, setView] = createSignal<View | null>(null);
  const [paused, setPaused] = createSignal(false);
  const [history, setHistory] = createSignal<{ t: number; nw: [number, number] }[]>([]);
  const [events, setEvents] = createSignal<FrameEvent[]>([]);
  let pending: FrameEvent[] = [];
  let playTime: number | null = null;
  let last = performance.now();

  const push = (f: LiveFrame) => {
    const t = frameTime(f);
    if (frames.length && t <= frameTime(frames[frames.length - 1]!)) return; // old or duplicate
    frames.push(f);
    if (frames.length > KEEP_FRAMES) frames.splice(0, frames.length - KEEP_FRAMES);
    pending.push(...f.events);
    const h = history();
    if (!h.length || t - h[h.length - 1]!.t >= 5) setHistory([...h, { t, nw: f.net_worth }]);
  };

  const step = (now: number) => {
    const dt = Math.min(0.5, (now - last) / 1000);
    last = now;
    if (frames.length) {
      const latest = frameTime(frames[frames.length - 1]!);
      if (playTime == null || latest - playTime > 9) playTime = Math.max(frameTime(frames[0]!), latest - 3);
      if (!paused()) playTime = Math.min(latest, playTime + dt);
      let i = frames.findIndex((f) => frameTime(f) > playTime!);
      if (i < 0) i = frames.length;
      const a = frames[Math.max(0, i - 1)]!;
      const b = frames[Math.min(frames.length - 1, i)]!;
      const span = frameTime(b) - frameTime(a);
      const alpha = span > 0 ? Math.min(1, Math.max(0, (playTime - frameTime(a)) / span)) : 0;
      const next = new Map(b.players.map((p) => [p.account_id, p]));
      const pos = new Map<number, [number, number]>();
      for (const p of a.players) {
        const q = next.get(p.account_id);
        if (p.x == null || p.y == null) continue;
        // Don't glide across the map when a hero respawns.
        const jump = q?.x != null && q.y != null && Math.hypot(q.x - p.x, q.y - p.y) > 2500;
        pos.set(p.account_id, q?.x != null && q.y != null && !jump ? [p.x + (q.x - p.x) * alpha, p.y + (q.y - p.y) * alpha] : [p.x, p.y]);
      }
      // Events appear when playback reaches them, together with the map.
      const due = pending.filter((e) => e.time_s <= playTime! + 0.01);
      if (due.length) {
        pending = pending.filter((e) => e.time_s > playTime! + 0.01);
        setEvents((old) => [...due.reverse(), ...old].slice(0, MAX_EVENTS));
      }
      setView({ frame: alpha < 0.5 ? a : b, time: playTime, pos });
    }
    raf = requestAnimationFrame(step);
  };
  let raf = requestAnimationFrame(step);
  onCleanup(() => cancelAnimationFrame(raf));

  const jumpToLive = () => {
    if (frames.length) playTime = frameTime(frames[frames.length - 1]!) - 1;
    setPaused(false);
  };
  const behind = () => {
    const v = view();
    if (!v || !frames.length) return null;
    return Math.round(v.frame.delay_s + (frameTime(frames[frames.length - 1]!) - v.time) + 3);
  };
  return { push, view, paused, setPaused, jumpToLive, behind, history, events, count: () => frames.length };
}

const OBJECTIVE_SIZE: Record<FrameObjective['kind'], number> = {
  guardian: 11,
  walker: 16,
  base_guardian: 9,
  patron: 18,
  patron_core: 14,
  midboss: 15,
};

function ObjectiveMarker(props: { o: FrameObjective; at: [number, number] }) {
  const s = () => OBJECTIVE_SIZE[props.o.kind] ?? 10;
  const color = () => (props.o.kind === 'midboss' ? '#b07cff' : props.o.team == null ? '#8a83a3' : TEAM_COLOR[props.o.team]);
  const share = () => (props.o.max_hp > 0 ? Math.min(1, props.o.hp / props.o.max_hp) : 1);
  const ring = () => 2 * Math.PI * (s() + 4);
  return (
    <g transform={`translate(${props.at[0] * 1000} ${props.at[1] * 1000})`}>
      <title>{`${props.o.kind.replace('_', ' ')} · ${Math.round(share() * 100)}%`}</title>
      <circle r={s() + 4} fill="none" stroke="rgb(0 0 0 / 0.5)" stroke-width="3" />
      <circle
        r={s() + 4}
        fill="none"
        stroke={color()}
        stroke-width="3"
        stroke-dasharray={`${ring() * share()} ${ring()}`}
        transform="rotate(-90)"
      />
      <Show
        when={props.o.kind === 'patron' || props.o.kind === 'patron_core' || props.o.kind === 'midboss'}
        fallback={<rect x={-s() / 2} y={-s() / 2} width={s()} height={s()} transform="rotate(45)" fill={color()} stroke="#0b0a10" stroke-width="2" />}
      >
        <circle r={s() / 1.6} fill={color()} stroke="#0b0a10" stroke-width="2" />
      </Show>
    </g>
  );
}

function HeroMarker(props: {
  p: FramePlayer;
  at: [number, number] | undefined;
  assets?: LiveAssets;
  selected: boolean;
  label: string;
  showName: boolean;
  onSelect: () => void;
}) {
  const hero = () => heroOf(props.assets, props.p.hero_id);
  const hp = () => (props.p.max_hp ? Math.max(0, Math.min(1, (props.p.hp ?? 0) / props.p.max_hp)) : 1);
  return (
    <Show when={props.at}>
      {(at) => (
        <g
          transform={`translate(${at()[0] * 1000} ${at()[1] * 1000})`}
          class="cursor-pointer"
          opacity={props.p.alive ? 1 : 0.45}
          onClick={(e) => {
            e.stopPropagation();
            props.onSelect();
          }}
        >
          <title>{`${hero()?.name ?? 'Hero'} · ${props.label}`}</title>
          <Show when={props.selected}>
            <circle r="25" fill="none" stroke="var(--color-gold-400)" stroke-width="3" />
          </Show>
          <circle r="17" fill="#121019" stroke={TEAM_COLOR[props.p.team]} stroke-width="3.5" />
          <Show when={hero()?.minimap ?? hero()?.icon}>
            {(src) => (
              <image href={src()} x="-14" y="-14" width="28" height="28" clip-path="url(#hero-clip)" filter={props.p.alive ? undefined : 'url(#grey)'} />
            )}
          </Show>
          <Show when={props.p.alive} fallback={<text y="5" text-anchor="middle" class="fill-ink-100 text-[15px] font-bold">{Math.ceil(props.p.respawn_in_s ?? 0) || '✝'}</text>}>
            <rect x="-17" y="20" width="34" height="5" rx="2" fill="rgb(0 0 0 / 0.7)" />
            <rect x="-17" y="20" width={34 * hp()} height="5" rx="2" fill={hp() > 0.5 ? '#3ecf8e' : hp() > 0.25 ? '#f5c451' : '#f2555a'} />
          </Show>
          <Show when={props.showName || props.selected}>
            <text y="-24" text-anchor="middle" class="pointer-events-none fill-ink-100 text-[13px] font-semibold" paint-order="stroke" stroke="#0b0a10" stroke-width="4">
              {props.label}
            </text>
          </Show>
        </g>
      )}
    </Show>
  );
}

function describe(e: FrameEvent, name: (id: number | null | undefined) => string): string {
  switch (e.type) {
    case 'kill':
      return e.killer ? `${name(e.killer)} killed ${name(e.victim)}` : `${name(e.victim)} died`;
    case 'purchase':
      return `${name(e.account_id)} bought`;
    case 'level_up':
      return `${name(e.account_id)} reached level ${e.level}`;
    case 'objective_destroyed':
      return `${e.team != null ? TEAM_NAMES[e.team] : 'A'} ${e.kind.replace('_', ' ')} fell`;
  }
}

function Locked(props: { info?: LiveMatchInfo }) {
  const w = () => props.info?.watch;
  return (
    <div class="flex flex-col items-center gap-3 px-6 py-12 text-center">
      <span class="text-3xl">🔒</span>
      <Show when={w()?.reason === 'LOGIN_REQUIRED'}>
        <p class="text-ink-200">Log in to watch this match live.</p>
        <A href="/login"><Button size="sm">Log in</Button></A>
      </Show>
      <Show when={w()?.reason === 'STAKE_REQUIRED'}>
        <Show
          when={props.info?.bettableMatchId}
          fallback={<p class="max-w-sm text-ink-200">The live map of matches without markets is for premium players.</p>}
        >
          <p class="max-w-sm text-ink-200">
            Bet at least {tokens(w()!.minStakeTokens)} NTK on this match to unlock its live map (you have {tokens(w()!.stakedTokens)} NTK on it).
          </p>
        </Show>
        <p class="text-xs text-ink-400">Premium players can watch every live match.</p>
      </Show>
    </div>
  );
}

export function LiveMap(props: { externalId: string; roster?: LivePlayer[] }) {
  const assets = useLiveAssets();
  const access = createQuery(() => ({
    queryKey: ['live', 'match', props.externalId, auth.user()?.id ?? 'anon'],
    queryFn: () => get<LiveMatchInfo>(`/api/live/matches/${props.externalId}`),
    // A bet placed meanwhile can unlock it.
    refetchInterval: (q: { state: { data?: LiveMatchInfo } }) => (q.state.data?.watch.allowed ? false : 15_000),
  }));
  const allowed = () => !!access.data?.watch.allowed;
  const [denied, setDenied] = createSignal(false);
  const play = usePlayback();
  const [selected, setSelected] = createSignal<number | null>(null);
  const [tab, setTab] = createSignal<'events' | 'stats' | 'souls'>('events');
  const [layers, setLayers] = createSignal({ lanes: true, objectives: true, names: false });

  useTopic(
    () => (allowed() && !denied() ? `watch:${props.externalId}` : null),
    (msg) => {
      if (msg.type === 'LIVE_FRAME' && msg.data) play.push(msg.data as LiveFrame);
      else if (msg.type === 'WATCH_DENIED') {
        setDenied(true);
        void access.refetch();
      }
    },
  );

  const names = createMemo(() => new Map((props.roster ?? access.data?.match?.players ?? []).map((p) => [p.account_id, p])));
  const name = (id: number | null | undefined) => (id == null ? '—' : playerName(names().get(id) ?? { account_id: id }));
  const heroName = (id: number | null | undefined) => {
    if (id == null) return '—';
    const p = play.view()?.frame.players.find((x) => x.account_id === id);
    return p ? (heroOf(assets.data, p.hero_id)?.name ?? name(id)) : name(id);
  };
  const radius = () => assets.data?.map.radius ?? 10752;
  const at = (x: number, y: number) => toMap(x, y, radius(), play.view()?.frame.minimap);
  const players = () => play.view()?.frame.players ?? [];
  const selectedPlayer = () => players().find((p) => p.account_id === selected());

  return (
    <Card
      title={
        <span class="flex items-center gap-2">
          Live map
          <Show when={play.view()}>
            <Badge tone="live" pulse>Live</Badge>
          </Show>
        </span>
      }
      actions={
        <Show when={play.behind()}>
          {(s) => <span class="text-xs text-ink-400" title="Valve's broadcast delay plus playback">≈ {s()} s behind the game</span>}
        </Show>
      }
    >
      <Show when={!access.isLoading} fallback={<div class="grid place-items-center py-16"><Spinner /></div>}>
        <Show when={allowed() && !denied()} fallback={<Locked info={access.data} />}>
          <div class="grid gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_340px]">
            <div class="flex flex-col gap-3">
              <div class="relative aspect-square w-full overflow-hidden rounded-xl border border-ink-700 bg-ink-950">
                <svg viewBox="0 0 1000 1000" class="size-full" role="img" aria-label="Live map" onClick={() => setSelected(null)}>
                  <defs>
                    <clipPath id="hero-clip"><circle r="14" /></clipPath>
                    <filter id="grey"><feColorMatrix type="saturate" values="0" /></filter>
                  </defs>
                  <Show when={assets.data?.map.image}>
                    {(src) => <image href={src()} x="0" y="0" width="1000" height="1000" preserveAspectRatio="none" opacity="0.55" />}
                  </Show>
                  <Show when={layers().lanes}>
                    <For each={assets.data?.map.lanes ?? []}>
                      {(lane) => (
                        <polyline
                          points={lane.points.map(([x, y]) => at(x, y).map((v) => (v * 1000).toFixed(1)).join(',')).join(' ')}
                          fill="none"
                          stroke={lane.color}
                          stroke-width="5"
                          stroke-linecap="round"
                          opacity="0.35"
                        />
                      )}
                    </For>
                  </Show>
                  <Show when={layers().objectives}>
                    <Index each={play.view()?.frame.objectives ?? []}>
                      {(o) => <ObjectiveMarker o={o()} at={at(o().x, o().y)} />}
                    </Index>
                  </Show>
                  <Index each={players()}>
                    {(p) => (
                      <HeroMarker
                        p={p()}
                        at={(() => {
                          const xy = play.view()?.pos.get(p().account_id);
                          return xy ? at(xy[0], xy[1]) : undefined;
                        })()}
                        assets={assets.data}
                        selected={selected() === p().account_id}
                        label={name(p().account_id)}
                        showName={layers().names}
                        onSelect={() => setSelected(p().account_id)}
                      />
                    )}
                  </Index>
                </svg>
                <Show when={!play.view()}>
                  <div class="absolute inset-0 grid place-items-center bg-ink-950/70 text-center">
                    <div class="flex flex-col items-center gap-2 px-6">
                      <Spinner class="size-6 text-gold-400" />
                      <p class="text-sm text-ink-200">Connecting to the match broadcast…</p>
                      <p class="text-xs text-ink-400">The first frames can take up to a minute while the bot joins the broadcast.</p>
                    </div>
                  </div>
                </Show>
                <Show when={play.view()}>
                  {(v) => (
                    <div class="pointer-events-none absolute left-3 top-3 flex items-center gap-2 rounded-lg bg-ink-950/80 px-2.5 py-1">
                      <span class="tabular font-mono text-sm font-bold text-ink-100">{clock(v().time)}</span>
                      <Show when={v().frame.paused}><Badge tone="warn">Paused in game</Badge></Show>
                    </div>
                  )}
                </Show>
                <Show when={play.view()}>
                  {(v) => (
                    <div class="pointer-events-none absolute right-3 top-3 flex flex-col items-end gap-0.5 rounded-lg bg-ink-950/80 px-2.5 py-1 text-xs">
                      <span class={`tabular font-semibold ${TEAM_TEXT[0]}`}>{compact(v().frame.net_worth[0])}</span>
                      <span class={`tabular font-semibold ${TEAM_TEXT[1]}`}>{compact(v().frame.net_worth[1])}</span>
                    </div>
                  )}
                </Show>
              </div>

              <div class="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="secondary" onClick={() => play.setPaused(!play.paused())} disabled={!play.view()}>
                  {play.paused() ? '▶ Play' : '⏸ Pause'}
                </Button>
                <Button size="sm" variant="ghost" onClick={play.jumpToLive} disabled={!play.view()}>⏭ Live</Button>
                <span class="mx-1 h-5 w-px bg-ink-700" />
                <For each={[['lanes', 'Lanes'], ['objectives', 'Objectives'], ['names', 'Names']] as const}>
                  {([key, label]) => (
                    <label class="flex cursor-pointer items-center gap-1.5 text-xs text-ink-300">
                      <input
                        type="checkbox"
                        class="accent-gold-500"
                        checked={layers()[key]}
                        onChange={(e) => setLayers({ ...layers(), [key]: e.currentTarget.checked })}
                      />
                      {label}
                    </label>
                  )}
                </For>
              </div>

              <Show when={selectedPlayer()}>
                {(p) => (
                  <div class="flex flex-wrap items-center gap-3 rounded-xl border border-ink-700 bg-ink-850 p-3">
                    <HeroIcon assets={assets.data} heroId={p().hero_id} class="size-10" />
                    <div class="min-w-0">
                      <p class={`truncate font-semibold ${TEAM_TEXT[p().team]}`}>{name(p().account_id)}</p>
                      <p class="tabular text-xs text-ink-400">
                        {heroOf(assets.data, p().hero_id)?.name} · level {p().level} · {p().kills}/{p().deaths}/{p().assists} · {compact(p().net_worth)} souls
                        {p().ult_ready ? ' · ult ready' : ''}
                      </p>
                    </div>
                    <div class="flex flex-wrap gap-1">
                      <For each={p().items}>
                        {(id) => (
                          <Show when={itemOf(assets.data, id)}>
                            {(it) => <img src={it().image ?? ''} alt={it().name} title={it().name} class="size-7 rounded bg-ink-800" loading="lazy" />}
                          </Show>
                        )}
                      </For>
                    </div>
                  </div>
                )}
              </Show>
            </div>

            <div class="flex min-w-0 flex-col gap-3">
              <Tabs
                value={tab()}
                onChange={setTab}
                options={[
                  { value: 'events', label: 'Events' },
                  { value: 'stats', label: 'Stats' },
                  { value: 'souls', label: 'Souls' },
                ]}
              />
              <Show when={tab() === 'events'}>
                <ol class="flex max-h-[560px] flex-col gap-1 overflow-y-auto pr-1">
                  <For each={play.events()} fallback={<li class="py-8 text-center text-xs text-ink-500">Kills, purchases and objectives show up here.</li>}>
                    {(e) => (
                      <li class="flex items-center gap-2 rounded-lg bg-ink-850 px-2.5 py-1.5 text-xs">
                        <span class="tabular w-10 shrink-0 font-mono text-ink-500">{clock(e.time_s)}</span>
                        <span class="shrink-0">
                          {e.type === 'kill' ? '⚔' : e.type === 'purchase' ? '🛒' : e.type === 'level_up' ? '⬆' : '💥'}
                        </span>
                        <span class="min-w-0 flex-1 truncate text-ink-200" title={describe(e, heroName)}>{describe(e, name)}</span>
                        <Show when={e.type === 'purchase' ? itemOf(assets.data, (e as { item_id: number }).item_id) : null}>
                          {(it) => (
                            <span class="flex shrink-0 items-center gap-1 text-ink-300">
                              <img src={it().image ?? ''} alt="" class="size-5 rounded" loading="lazy" />
                              <span class="max-w-24 truncate">{it().name}</span>
                            </span>
                          )}
                        </Show>
                      </li>
                    )}
                  </For>
                </ol>
              </Show>
              <Show when={tab() === 'stats'}>
                <div class="flex flex-col gap-3">
                  <For each={[0, 1] as const}>
                    {(team) => (
                      <div>
                        <p class={`mb-1 text-xs font-bold uppercase tracking-wider ${TEAM_TEXT[team]}`}>{TEAM_NAMES[team]}</p>
                        <ul class="flex flex-col gap-1">
                          <For each={players().filter((p) => p.team === team)}>
                            {(p) => (
                              <li
                                class={`flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-xs ${selected() === p.account_id ? 'bg-gold-500/10 ring-1 ring-gold-500/40' : 'bg-ink-850 hover:bg-ink-800'}`}
                                onClick={() => setSelected(p.account_id)}
                              >
                                <HeroIcon assets={assets.data} heroId={p.hero_id} class="size-7" dim={!p.alive} />
                                <div class="min-w-0 flex-1">
                                  <div class="flex items-center gap-1">
                                    <span class="truncate text-ink-100">{name(p.account_id)}</span>
                                    <RankBadge assets={assets.data} badge={names().get(p.account_id)?.badge} />
                                  </div>
                                  <div class="mt-0.5 h-1 overflow-hidden rounded bg-ink-700">
                                    <div class="h-full bg-win" style={{ width: `${p.max_hp ? Math.round(((p.hp ?? 0) / p.max_hp) * 100) : 0}%` }} />
                                  </div>
                                </div>
                                <span class="tabular w-8 text-right text-ink-400">Lv{p.level}</span>
                                <span class="tabular w-14 text-right text-ink-200">{p.kills}/{p.deaths}/{p.assists}</span>
                                <span class="tabular w-10 text-right text-gold-300">{compact(p.net_worth)}</span>
                              </li>
                            )}
                          </For>
                        </ul>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
              <Show when={tab() === 'souls'}>
                <SoulsChart history={play.history()} />
              </Show>
            </div>
          </div>
        </Show>
      </Show>
    </Card>
  );
}

/** Souls lead over time: above the line Hidden King leads, below Archmother. */
function SoulsChart(props: { history: { t: number; nw: [number, number] }[] }) {
  const W = 320;
  const H = 160;
  const d = createMemo(() => {
    const h = props.history;
    if (h.length < 2) return null;
    const t0 = h[0]!.t;
    const t1 = h[h.length - 1]!.t;
    const max = Math.max(1000, ...h.map((p) => Math.abs(p.nw[0] - p.nw[1])));
    const x = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * W;
    const y = (lead: number) => H / 2 - (lead / max) * (H / 2 - 8);
    return { path: h.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.nw[0] - p.nw[1]).toFixed(1)}`).join(' '), max, t0, t1 };
  });
  return (
    <Show when={d()} fallback={<p class="py-8 text-center text-xs text-ink-500">The souls graph fills in while you watch.</p>}>
      {(c) => (
        <div>
          <svg viewBox={`0 0 ${W} ${H}`} class="h-40 w-full" role="img" aria-label="Souls lead over time">
            <rect x="0" y="0" width={W} height={H / 2} fill="var(--color-amber-team)" opacity="0.06" />
            <rect x="0" y={H / 2} width={W} height={H / 2} fill="var(--color-sapphire-team)" opacity="0.06" />
            <line x1="0" x2={W} y1={H / 2} y2={H / 2} stroke="#3a3550" />
            <path d={c().path} fill="none" stroke="var(--color-gold-400)" stroke-width="2" vector-effect="non-scaling-stroke" />
          </svg>
          <div class="mt-1 flex justify-between text-[11px] text-ink-400">
            <span>{clock(c().t0)}</span>
            <span>± {compact(c().max)} souls</span>
            <span>{clock(c().t1)}</span>
          </div>
        </div>
      )}
    </Show>
  );
}
