/**
 * Realtime map of a live Deadlock match: hero positions, health, levels, items, objectives and events, from the
 * Steam bot's broadcast frames (WebSocket topic watch:{deadlockMatchId}).
 *
 * Frames arrive in bursts (Valve's broadcast comes in ~3 s fragments, sampled twice a second), so they are played back
 * on a game clock and positions are interpolated between frames. The data is about 25 s behind the real game.
 */
import { A } from '@solidjs/router';
import { createQuery } from '@tanstack/solid-query';
import { createEffect, createMemo, createSignal, For, Index, onCleanup, Show, untrack, type JSX } from 'solid-js';
import { get } from '../api/client';
import type { FrameEvent, FrameSinner, LiveAssets, LiveFrame, LiveMatchInfo, LivePlayer } from '../api/types';
import { auth } from '../lib/auth';
import { clock, compact, tokens } from '../lib/format';
import { RIFT_ICON, TEAM_COLOR, TEAM_NAMES, TEAM_TEXT, URN_ICON, abilityOf, heroOf, itemOf, objectiveIcon, toMap, useLiveAssets } from '../lib/live';
import { advance, liveClock, type PlayClock } from '../lib/playback';
import { useTopic } from '../lib/ws';
import { HeroIcon, RankBadge, playerName } from './live';
import { LiveMap25D, type MapLayers, type MapQuality } from './LiveMap25D';
import { AbilityRow, CampMarker, MapScale, MidbossTimer, ObjectiveStatus, PowerupMarker, RiftCapturers, campKinds } from './liveMapLayers';
import {
  HeroMarker,
  ObjectiveMarker,
  RIFT_COLOR,
  RiftMarker,
  URN_COLOR,
  UrnCarried,
  UrnDelivery,
  UrnMarker,
  isGlyph,
  objectiveColor,
} from './liveMapMarkers';
import { Badge, Button, Card, Spinner, Tabs } from './ui';

const KEEP_FRAMES = 600; // 5 minutes at 2 frames per second: how long a pause can last
const MAX_EVENTS = 80;

/** A hero's world position, and the height of its feet when the frames carry it (bots before z don't). */
type HeroPos = [x: number, y: number, z: number | null];

interface View {
  frame: LiveFrame;
  time: number;
  pos: Map<number, HeroPos>;
}

function frameTime(f: LiveFrame): number {
  return f.game_time_s ?? f.tick / 64;
}

/** The value a share `t` of the way from a to b; a when b is unknown. */
const mix = (a: number, b: number | null | undefined, t: number) => (b == null ? a : a + (b - a) * t);

/** Playback of buffered frames on a game clock, with positions interpolated between neighbours. */
function usePlayback() {
  const frames: LiveFrame[] = [];
  const [view, setView] = createSignal<View | null>(null);
  const [paused, setPaused] = createSignal(false);
  const [history, setHistory] = createSignal<{ t: number; nw: [number, number] }[]>([]);
  const [events, setEvents] = createSignal<FrameEvent[]>([]);
  let pending: FrameEvent[] = [];
  let playClock: PlayClock = { time: null, held: false };
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
      playClock = advance(playClock, frameTime(frames[0]!), frameTime(frames[frames.length - 1]!), dt, paused());
      const playTime = playClock.time!;
      let i = frames.findIndex((f) => frameTime(f) > playTime);
      if (i < 0) i = frames.length;
      const a = frames[Math.max(0, i - 1)]!;
      const b = frames[Math.min(frames.length - 1, i)]!;
      const span = frameTime(b) - frameTime(a);
      const alpha = span > 0 ? Math.min(1, Math.max(0, (playTime - frameTime(a)) / span)) : 0;
      const next = new Map(b.players.map((p) => [p.account_id, p]));
      const pos = new Map<number, HeroPos>();
      for (const p of a.players) {
        const q = next.get(p.account_id);
        if (p.x == null || p.y == null) continue;
        // Don't glide across the map (or up and down) when a hero respawns.
        const jump = q?.x != null && q.y != null && Math.hypot(q.x - p.x, q.y - p.y) > 2500;
        const t = q?.x != null && q.y != null && !jump ? alpha : 0;
        pos.set(p.account_id, [mix(p.x, q?.x, t), mix(p.y, q?.y, t), p.z == null ? null : mix(p.z, q?.z, t)]);
      }
      // Events appear when playback reaches them, together with the map.
      const due = pending.filter((e) => e.time_s <= playTime + 0.01);
      if (due.length) {
        pending = pending.filter((e) => e.time_s > playTime + 0.01);
        setEvents((old) => [...due.reverse(), ...old].slice(0, MAX_EVENTS));
      }
      setView({ frame: alpha < 0.5 ? a : b, time: playTime, pos });
    }
    raf = requestAnimationFrame(step);
  };
  let raf = requestAnimationFrame(step);
  onCleanup(() => cancelAnimationFrame(raf));

  const jumpToLive = () => {
    if (frames.length) playClock = liveClock(frameTime(frames[frames.length - 1]!));
    setPaused(false);
  };
  const behind = () => {
    const v = view();
    if (!v || !frames.length) return null;
    return Math.round(v.frame.delay_s + (frameTime(frames[frames.length - 1]!) - v.time) + 3);
  };
  return { push, view, paused, setPaused, jumpToLive, behind, history, events, count: () => frames.length };
}

/** The icon in front of an event: the objective's, rift's or urn's own icon, else a symbol. */
function eventIcon(e: FrameEvent): JSX.Element {
  const framed = (src: string, color: string, glyph: boolean) => (
    <img
      src={src}
      alt=""
      class={`size-5 rounded-md bg-ink-950 ${glyph ? 'object-contain p-0.5' : 'object-cover'}`}
      style={{ 'box-shadow': `0 0 0 1.5px ${color}` }}
      loading="lazy"
    />
  );
  switch (e.type) {
    case 'objective_destroyed': {
      const src = objectiveIcon(e.kind, e.team);
      return src ? framed(src, objectiveColor(e.kind, e.team), isGlyph(e.kind)) : <span>💥</span>;
    }
    case 'midboss_killed':
      return framed('/icons/objectives/midboss.webp', e.team == null ? '#b07cff' : TEAM_COLOR[e.team], true);
    case 'rift_appeared':
    case 'rift_opened':
    case 'rift_closed':
      return framed(RIFT_ICON, RIFT_COLOR, true);
    case 'rift_captured':
      return framed(RIFT_ICON, TEAM_COLOR[e.team], true);
    case 'urn_delivered':
      return framed(URN_ICON, TEAM_COLOR[e.team], true);
    case 'urn_spawned':
    case 'urn_picked_up':
    case 'urn_dropped':
      return framed(URN_ICON, URN_COLOR, true);
    case 'kill':
      return <span>⚔</span>;
    case 'purchase':
      return <span>🛒</span>;
    case 'level_up':
      return <span>⬆</span>;
    case 'ability_unlocked':
      return <span title="Ability unlocked">🔓</span>;
    case 'ability_upgraded':
      return <span title="Ability point" class="font-bold text-gold-300">+</span>;
  }
}

/** What an event is about, on the right of the row: the item bought, or the ability with its points (of 3). */
function eventExtra(e: FrameEvent, assets?: LiveAssets): JSX.Element | null {
  const thing = (image: string | null, name: string, after?: JSX.Element) => (
    <span class="flex shrink-0 items-center gap-1 text-ink-300">
      <img src={image ?? ''} alt="" class="size-5 rounded bg-ink-800 object-contain" loading="lazy" />
      <span class="max-w-24 truncate">{name}</span>
      {after}
    </span>
  );
  if (e.type === 'purchase') {
    const item = itemOf(assets, e.item_id);
    return item ? thing(item.image, item.name) : null;
  }
  if (e.type === 'ability_unlocked' || e.type === 'ability_upgraded') {
    const ability = abilityOf(assets, e.ability_id);
    if (!ability) return null;
    const tier = e.type === 'ability_upgraded' ? e.tier : 0;
    const pips = (
      <span class="flex gap-0.5" title={`${tier} of 3 points`}>
        <For each={[1, 2, 3]}>{(i) => <span class={`size-1.5 rounded-full ${i <= tier ? 'bg-gold-400' : 'bg-ink-700'}`} />}</For>
      </span>
    );
    return thing(ability.image, ability.name, pips);
  }
  return null;
}

function describe(e: FrameEvent, name: (id: number | null | undefined) => string, ability: (id: number) => string): string {
  switch (e.type) {
    case 'kill':
      return e.killer ? `${name(e.killer)} killed ${name(e.victim)}` : `${name(e.victim)} died`;
    case 'purchase':
      return `${name(e.account_id)} bought`;
    case 'level_up':
      return `${name(e.account_id)} reached level ${e.level}`;
    case 'ability_unlocked':
      return `${name(e.account_id)} unlocked ${ability(e.ability_id)}`;
    case 'ability_upgraded':
      return `${name(e.account_id)} put a point into ${ability(e.ability_id)} (${e.tier} of 3)`;
    case 'objective_destroyed':
      return `${e.team != null ? TEAM_NAMES[e.team] : 'A'} ${e.kind.replace('_', ' ')} fell`;
    case 'midboss_killed':
      if (e.killer != null) return `${name(e.killer)} killed the Mid-Boss`;
      return e.team == null ? 'The Mid-Boss was killed' : `${TEAM_NAMES[e.team]} killed the Mid-Boss`;
    case 'urn_spawned':
      return 'The Soul Urn appeared';
    case 'urn_picked_up':
      return `${name(e.account_id)} picked up the Soul Urn`;
    case 'urn_dropped':
      return `${name(e.account_id)} dropped the Soul Urn`;
    case 'urn_delivered':
      return `${name(e.account_id)} delivered the Soul Urn for ${TEAM_NAMES[e.team]}`;
    case 'rift_appeared':
      return 'An Unstable Rift is appearing';
    case 'rift_opened':
      return 'The Unstable Rift opened';
    case 'rift_captured':
      return `${TEAM_NAMES[e.team]} captured the Unstable Rift`;
    case 'rift_closed':
      return 'The Unstable Rift closed without being captured';
  }
}

interface Who {
  name: string;
  heroId?: number;
  team?: 0 | 1;
}

/** A player in the event list: hero icon, then the name in the team's colour, so bettors can tell who is who. */
function PlayerTag(props: { who: Who; assets?: LiveAssets }) {
  return (
    <span class="inline-flex min-w-0 items-center gap-1">
      <Show when={props.who.heroId}>
        {(heroId) => <HeroIcon assets={props.assets} heroId={heroId()} class="size-4" />}
      </Show>
      <span class={`truncate font-medium ${props.who.team == null ? 'text-ink-200' : TEAM_TEXT[props.who.team]}`}>
        {props.who.name}
      </span>
    </span>
  );
}

/** The same sentence as `describe`, with every player shown by `tag`. */
function eventText(e: FrameEvent, tag: (id: number) => JSX.Element): JSX.Element {
  const words = (text: string) => <span class="shrink-0 whitespace-nowrap text-ink-400">{text}</span>;
  switch (e.type) {
    case 'kill':
      return e.killer ? <>{tag(e.killer)}{words('killed')}{tag(e.victim)}</> : <>{tag(e.victim)}{words('died')}</>;
    case 'purchase':
      return <>{tag(e.account_id)}{words('bought')}</>;
    case 'level_up':
      return <>{tag(e.account_id)}{words(`reached level ${e.level}`)}</>;
    case 'ability_unlocked':
      return <>{tag(e.account_id)}{words('unlocked')}</>;
    case 'ability_upgraded':
      return <>{tag(e.account_id)}{words('put a point into')}</>;
    case 'objective_destroyed':
      return (
        <span class="truncate">
          <span class={e.team != null ? `font-medium ${TEAM_TEXT[e.team]}` : ''}>{e.team != null ? TEAM_NAMES[e.team] : 'A'}</span>
          {` ${e.kind.replace('_', ' ')} fell`}
        </span>
      );
    case 'midboss_killed':
      if (e.killer != null) return <>{tag(e.killer)}{words('killed the Mid-Boss')}</>;
      return e.team == null ? (
        <span class="truncate">The Mid-Boss was killed</span>
      ) : (
        <span class="truncate">
          <span class={`font-medium ${TEAM_TEXT[e.team]}`}>{TEAM_NAMES[e.team]}</span> killed the Mid-Boss
        </span>
      );
    case 'urn_spawned':
      return <span class="truncate">The Soul Urn appeared</span>;
    case 'urn_picked_up':
      return <>{tag(e.account_id)}{words('picked up the Soul Urn')}</>;
    case 'urn_dropped':
      return <>{tag(e.account_id)}{words('dropped the Soul Urn')}</>;
    case 'urn_delivered':
      return <>{tag(e.account_id)}{words('delivered the Soul Urn')}</>;
    case 'rift_appeared':
      return <span class="truncate">An Unstable Rift is appearing</span>;
    case 'rift_opened':
      return <span class="truncate">The Unstable Rift opened</span>;
    case 'rift_captured':
      return (
        <span class="truncate">
          <span class={`font-medium ${TEAM_TEXT[e.team]}`}>{TEAM_NAMES[e.team]}</span> captured the Unstable Rift
        </span>
      );
    case 'rift_closed':
      return <span class="truncate">The Unstable Rift closed uncaptured</span>;
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

/** Event list filters. */
const EVENT_GROUPS = {
  all: 'All',
  fights: 'Fights',
  objectives: 'Objectives',
  abilities: 'Abilities',
  items: 'Items',
} as const;
type EventGroup = keyof typeof EVENT_GROUPS;

function eventGroup(e: FrameEvent): Exclude<EventGroup, 'all'> {
  switch (e.type) {
    case 'kill':
      return 'fights';
    case 'purchase':
      return 'items';
    case 'level_up':
    case 'ability_unlocked':
    case 'ability_upgraded':
      return 'abilities';
    default:
      return 'objectives';
  }
}

/**
 * The map seen from straight above (the minimap), tilted with the minimap's buildings raised (2.5D), or tilted with
 * the game's own map geometry (3D).
 */
type MapView = '2d' | '25d' | '3d';
const VIEW_KEY = 'naebka.liveMap.view';

function savedView(): MapView {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return v === '25d' || v === '3d' ? v : '2d';
  } catch {
    return '2d';
  }
}

function saveView(view: MapView) {
  try {
    localStorage.setItem(VIEW_KEY, view);
  } catch {
    // storage blocked: the choice lasts until the page is left
  }
}

const QUALITY_KEY = 'naebka.liveMap.quality';

function savedQuality(): MapQuality {
  try {
    return localStorage.getItem(QUALITY_KEY) === 'high' ? 'high' : 'standard';
  } catch {
    return 'standard';
  }
}

function saveQuality(quality: MapQuality) {
  try {
    localStorage.setItem(QUALITY_KEY, quality);
  } catch {
    // storage blocked: the choice lasts until the page is left
  }
}

/** Switches between the 2D, 2.5D and 3D views; the choice is remembered in this browser. */
function ViewSwitch(props: { value: MapView; onChange: (view: MapView) => void }) {
  const options: { value: MapView; label: string; title: string }[] = [
    { value: '2d', label: '2D', title: 'The minimap, from straight above' },
    { value: '25d', label: '2.5D', title: "Tilted, with the minimap's buildings standing up: drag, scroll and right-drag to look around" },
    { value: '3d', label: '3D', title: "The game's own map, simplified, in its colours: drag, scroll and right-drag to look around" },
  ];
  return (
    <div role="radiogroup" aria-label="Map view" class="absolute bottom-3 left-3 flex overflow-hidden rounded-lg bg-ink-950/85 ring-1 ring-ink-700">
      <For each={options}>
        {(o) => (
          <button
            role="radio"
            aria-checked={props.value === o.value}
            title={o.title}
            class={`px-2.5 py-1 text-xs font-semibold transition-colors ${props.value === o.value ? 'bg-gold-500/15 text-gold-300' : 'text-ink-300 hover:bg-ink-800 hover:text-ink-100'}`}
            onClick={() => props.onChange(o.value)}
          >
            {o.label}
          </button>
        )}
      </For>
    </div>
  );
}

const MIN_VIEW = 200; // most zoomed in: a fifth of the map across

/**
 * Zoom (wheel, buttons) and pan (drag) for the map's SVG, as its viewBox. A drag doesn't count as a click, so it
 * doesn't select or deselect heroes.
 */
function usePanZoom() {
  // A box equal to the current one changes nothing, so it doesn't redraw the map or wake what depends on it.
  const [box, setBox] = createSignal({ x: 0, y: 0, w: 1000 }, { equals: (a, b) => a.x === b.x && a.y === b.y && a.w === b.w });
  let svg: SVGSVGElement | undefined;
  let drag: { px: number; py: number; x: number; y: number; moved: boolean } | null = null;
  let suppressClick = false;

  const clamp = (b: { x: number; y: number; w: number }) => {
    const w = Math.max(MIN_VIEW, Math.min(1000, b.w));
    return { w, x: Math.max(0, Math.min(1000 - w, b.x)), y: Math.max(0, Math.min(1000 - w, b.y)) };
  };
  /** Zoom by `factor` (< 1 zooms in) keeping the map point under (fx, fy) (0–1 of the view) in place. */
  const zoom = (factor: number, fx = 0.5, fy = 0.5) => {
    const b = box();
    const w = Math.max(MIN_VIEW, Math.min(1000, b.w * factor));
    setBox(clamp({ w, x: b.x + fx * b.w - fx * w, y: b.y + fy * b.w - fy * w }));
  };
  const centerOn = (x: number, y: number) => {
    // Following calls this from an effect: reading the box there would make the effect wake itself with this write,
    // over and over, until the stack overflowed.
    const b = untrack(box);
    setBox(clamp({ w: b.w, x: x - b.w / 2, y: y - b.w / 2 }));
  };
  const reset = () => setBox({ x: 0, y: 0, w: 1000 });

  const bind = (el: SVGSVGElement) => {
    svg = el;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoom(e.deltaY < 0 ? 0.8 : 1.25, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    onCleanup(() => el.removeEventListener('wheel', onWheel));
  };
  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const b = box();
    drag = { px: e.clientX, py: e.clientY, x: b.x, y: b.y, moved: false };
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!drag || !svg) return;
    const r = svg.getBoundingClientRect();
    const dx = e.clientX - drag.px;
    const dy = e.clientY - drag.py;
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;
    if (!drag.moved) svg.setPointerCapture(e.pointerId);
    drag.moved = true;
    const w = box().w;
    setBox(clamp({ w, x: drag.x - (dx / r.width) * w, y: drag.y - (dy / r.height) * w }));
  };
  const onPointerUp = (e: PointerEvent) => {
    if (drag?.moved) {
      suppressClick = true;
      setTimeout(() => (suppressClick = false), 0);
      svg?.releasePointerCapture(e.pointerId);
    }
    drag = null;
  };
  /** Wraps a click handler so the click that ends a drag is ignored. */
  const click = (f: () => void) => () => {
    if (!suppressClick) f();
  };
  // A memo, so what depends on it (following) wakes when the map is zoomed in or out, not on every move.
  const zoomed = createMemo(() => box().w < 999);
  return { box, zoom, reset, centerOn, bind, onPointerDown, onPointerMove, onPointerUp, click, zoomed };
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
  const view = usePanZoom();
  const [selected, setSelected] = createSignal<number | null>(null);
  const [follow, setFollow] = createSignal(false);
  const [tab, setTab] = createSignal<'events' | 'stats' | 'builds' | 'souls'>('events');
  const [filter, setFilter] = createSignal<EventGroup>('all');
  const [layers, setLayers] = createSignal<MapLayers>({ lanes: true, objectives: true, camps: true, names: false, buildings: true });
  const [mapView, setMapView] = createSignal<MapView>(savedView());
  const chooseView = (v: MapView) => {
    setMapView(v);
    saveView(v);
  };
  const [quality, setQuality] = createSignal<MapQuality>(savedQuality());
  const chooseQuality = (q: MapQuality) => {
    setQuality(q);
    saveQuality(q);
  };

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
  const frame = () => play.view()?.frame;
  const players = () => frame()?.players ?? [];
  const selectedPlayer = () => players().find((p) => p.account_id === selected());
  const abilityName = (id: number) => abilityOf(assets.data, id)?.name ?? 'an ability';
  // The carried urn follows its carrier's (interpolated) marker.
  const urnCarrier = () => frame()?.urn?.carrier ?? null;
  const urnCarrierTeam = () => players().find((p) => p.account_id === urnCarrier())?.team ?? null;
  const heroAt = (id: number | null): [number, number] | null => {
    const xy = id == null ? undefined : play.view()?.pos.get(id);
    return xy ? at(xy[0], xy[1]) : null;
  };
  /** A hero's interpolated height in world units; null in frames from bots that don't send it. */
  const heroZ = (id: number | null): number | null => (id == null ? null : (play.view()?.pos.get(id)?.[2] ?? null));
  // Hero and team from the broadcast, or from the match's roster before the first frame.
  const who = (id: number): Who => {
    const live = players().find((p) => p.account_id === id);
    const listed = names().get(id);
    return { name: name(id), heroId: live?.hero_id ?? listed?.hero_id, team: live?.team ?? listed?.team };
  };
  const tag = (id: number) => <PlayerTag who={who(id)} assets={assets.data} />;

  // Camps: kinds from the map assets, and the Sinner's Sacrifice standing at each vault.
  const kindOf = createMemo(() => campKinds(assets.data));
  const sinnerAt = (x: number, y: number): FrameSinner | undefined =>
    frame()?.sinners?.find((s) => (s.x - x) ** 2 + (s.y - y) ** 2 < 600 * 600);
  const campCounts = () => {
    const camps = frame()?.camps ?? [];
    const kind = kindOf();
    const up = (c: (typeof camps)[number]) => c.respawn_in_s == null || c.respawn_in_s <= 0;
    const sinners = camps.filter((c) => kind(c) === 'vault');
    return { up: camps.filter(up).length, total: camps.length, sinnersUp: sinners.filter(up).length, sinners: sinners.length };
  };
  const midboss = () => frame()?.objectives.find((o) => o.kind === 'midboss');

  // Follow the selected hero while zoomed in (the 2.5D view follows by itself).
  const followed = () => (mapView() === '2d' && follow() && view.zoomed() ? heroAt(selected()) : null);
  createEffect(() => {
    const xy = followed();
    if (xy) view.centerOn(xy[0] * 1000, xy[1] * 1000);
  });
  const scale = () => Math.max(0.45, Math.sqrt(view.box().w / 1000));
  const events = () => (filter() === 'all' ? play.events() : play.events().filter((e) => eventGroup(e) === filter()));
  const toggle = (key: keyof ReturnType<typeof layers>, label: string) => (
    <label class="flex cursor-pointer items-center gap-1.5 text-xs text-ink-300">
      <input type="checkbox" class="accent-gold-500" checked={layers()[key]} onChange={(e) => setLayers({ ...layers(), [key]: e.currentTarget.checked })} />
      {label}
    </label>
  );

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
          {/* Side by side only when the card itself is wide (on the betting page it shares the row with the bet slip). */}
          <div class="@container">
          <div class="grid gap-4 p-4 @5xl:grid-cols-[minmax(0,1fr)_360px]">
            <div class="flex min-w-0 flex-col gap-3">
              <div class={`relative w-full overflow-hidden rounded-xl border border-ink-700 bg-ink-950 ${mapView() === '2d' ? 'aspect-square' : 'aspect-[4/3]'}`}>
                {/* The 2.5D and 3D views are one component, so switching between them keeps the camera. */}
                <Show
                  when={mapView() !== '2d'}
                  fallback={
                    <MapScale.Provider value={scale}>
                      <svg
                        ref={view.bind}
                        viewBox={`${view.box().x} ${view.box().y} ${view.box().w} ${view.box().w}`}
                        class={`size-full touch-none select-none ${view.zoomed() ? 'cursor-grab active:cursor-grabbing' : ''}`}
                        role="img"
                        aria-label="Live map"
                        onClick={view.click(() => setSelected(null))}
                        onPointerDown={view.onPointerDown}
                        onPointerMove={view.onPointerMove}
                        onPointerUp={view.onPointerUp}
                        onPointerCancel={view.onPointerUp}
                        onDblClick={() => view.reset()}
                      >
                        <defs>
                          <clipPath id="hero-clip"><circle r="14" /></clipPath>
                          <clipPath id="rounded" clipPathUnits="objectBoundingBox"><rect width="1" height="1" rx="0.25" /></clipPath>
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
                                stroke-width={5 * scale()}
                                stroke-linecap="round"
                                opacity="0.35"
                              />
                            )}
                          </For>
                        </Show>
                        <Show when={layers().camps}>
                          <Index each={frame()?.camps ?? []}>
                            {(c) => <CampMarker camp={c()} kind={kindOf()(c())} sinner={sinnerAt(c().x, c().y)} at={at(c().x, c().y)} />}
                          </Index>
                        </Show>
                        <Show when={layers().objectives}>
                          <Index each={frame()?.objectives ?? []}>
                            {(o) => <ObjectiveMarker o={o()} at={at(o().x, o().y)} />}
                          </Index>
                          <Show when={!midboss() && frame()?.midboss_respawn_in_s}>
                            {(left) => <MidbossTimer left={left()} at={at(0, 0)} />}
                          </Show>
                          <Index each={frame()?.powerups ?? []}>{(p) => <PowerupMarker at={at(p().x, p().y)} kind={p().kind} />}</Index>
                          <Show when={frame()?.rift}>{(r) => <RiftMarker r={r()} at={at(r().x, r().y)} />}</Show>
                          <Show when={frame()?.urn?.delivery}>
                            {(d) => <UrnDelivery at={at(d()[0], d()[1])} color={urnCarrierTeam() == null ? URN_COLOR : TEAM_COLOR[urnCarrierTeam()!]} />}
                          </Show>
                          <Show when={frame()?.urn?.carrier == null && frame()?.urn}>
                            {(u) => <UrnMarker at={at(u().x, u().y)} value={u().value} />}
                          </Show>
                        </Show>
                        <Index each={players()}>
                          {(p) => (
                            <HeroMarker
                              p={p()}
                              at={heroAt(p().account_id) ?? undefined}
                              assets={assets.data}
                              selected={selected() === p().account_id}
                              label={name(p().account_id)}
                              showName={layers().names}
                              onSelect={view.click(() => setSelected(p().account_id))}
                            />
                          )}
                        </Index>
                        <Show when={layers().objectives && heroAt(urnCarrier())}>{(xy) => <UrnCarried at={xy()} />}</Show>
                      </svg>
                    </MapScale.Provider>
                  }
                >
                  <LiveMap25D
                    scene={mapView() === '3d' ? 'model' : 'terrain'}
                    quality={quality()}
                    frame={frame()}
                    assets={assets.data}
                    at={at}
                    heroAt={heroAt}
                    heroZ={heroZ}
                    layers={layers()}
                    selected={selected()}
                    onSelect={(id) => setSelected(id)}
                    label={name}
                    campKind={kindOf()}
                    sinnerAt={sinnerAt}
                    carrierTeam={urnCarrierTeam()}
                    follow={follow()}
                  />
                </Show>
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
                <Show when={mapView() === '2d'}>
                  <div class="absolute bottom-3 right-3 flex flex-col overflow-hidden rounded-lg bg-ink-950/85 ring-1 ring-ink-700">
                    <button class="px-2.5 py-1 text-sm text-ink-200 hover:bg-ink-800" title="Zoom in (or scroll)" onClick={() => view.zoom(0.7)}>+</button>
                    <button class="px-2.5 py-1 text-sm text-ink-200 hover:bg-ink-800" title="Zoom out" onClick={() => view.zoom(1 / 0.7)}>−</button>
                    <Show when={view.zoomed()}>
                      <button class="px-2.5 py-1 text-xs text-ink-300 hover:bg-ink-800" title="Whole map (or double-click)" onClick={() => view.reset()}>⤢</button>
                    </Show>
                  </div>
                </Show>
                <ViewSwitch value={mapView()} onChange={chooseView} />
              </div>

              <div class="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="secondary" onClick={() => play.setPaused(!play.paused())} disabled={!play.view()}>
                  {play.paused() ? '▶ Play' : '⏸ Pause'}
                </Button>
                <Button size="sm" variant="ghost" onClick={play.jumpToLive} disabled={!play.view()}>⏭ Live</Button>
                <span class="mx-1 h-5 w-px bg-ink-700" />
                {toggle('lanes', 'Lanes')}
                {toggle('objectives', 'Objectives')}
                {toggle('camps', 'Camps')}
                {toggle('names', 'Names')}
                {/* The 3D view's buildings are the game's own, so they always stand. */}
                <Show when={mapView() === '25d'}>{toggle('buildings', 'Buildings')}</Show>
                <Show when={mapView() !== '2d'}>
                  <label
                    class="flex cursor-pointer items-center gap-1.5 text-xs text-ink-300"
                    title="Sharper drawing, and in 3D the game's map in more detail, with the sun's shadows. Needs a faster graphics card; remembered in this browser."
                  >
                    <input
                      type="checkbox"
                      class="accent-gold-500"
                      checked={quality() === 'high'}
                      onChange={(e) => chooseQuality(e.currentTarget.checked ? 'high' : 'standard')}
                    />
                    High quality
                  </label>
                </Show>
                <Show when={selected() != null}>
                  <label class="flex cursor-pointer items-center gap-1.5 text-xs text-ink-300" title="Keep the selected hero in the middle while zoomed in">
                    <input
                      type="checkbox"
                      class="accent-gold-500"
                      checked={follow()}
                      onChange={(e) => {
                        setFollow(e.currentTarget.checked);
                        if (e.currentTarget.checked && mapView() === '2d' && !view.zoomed()) view.zoom(0.45);
                      }}
                    />
                    Follow
                  </label>
                </Show>
              </div>

              <Show when={selectedPlayer()}>
                {(p) => (
                  <div class="flex flex-col gap-3 rounded-xl border border-ink-700 bg-ink-850 p-3">
                    <div class="flex flex-wrap items-center gap-3">
                      <HeroIcon assets={assets.data} heroId={p().hero_id} class="size-10" />
                      <div class="min-w-0 flex-1">
                        <p class={`truncate font-semibold ${TEAM_TEXT[p().team]}`}>{name(p().account_id)}</p>
                        <p class="tabular text-xs text-ink-400">
                          {heroOf(assets.data, p().hero_id)?.name} · level {p().level} · {p().kills}/{p().deaths}/{p().assists}
                          {p().ult_ready ? ' · ult ready' : ''}
                        </p>
                      </div>
                      <AbilityRow abilities={p().abilities} assets={assets.data} size="md" />
                    </div>
                    <div class="grid grid-cols-3 gap-2 text-center sm:grid-cols-6">
                      <For
                        each={[
                          ['Souls', compact(p().net_worth)],
                          ['Unspent', p().souls != null ? compact(p().souls) : '–'],
                          ['Last hits', p().last_hits ?? '–'],
                          ['Denies', p().denies ?? '–'],
                          ['Hero dmg', p().hero_damage != null ? compact(p().hero_damage) : '–'],
                          ['Obj. dmg', p().objective_damage != null ? compact(p().objective_damage) : '–'],
                        ] as const}
                      >
                        {([label, value]) => (
                          <div class="rounded-lg bg-ink-900 px-2 py-1">
                            <p class="text-[10px] uppercase tracking-wider text-ink-500">{label}</p>
                            <p class="tabular text-sm font-semibold text-ink-100">{value}</p>
                          </div>
                        )}
                      </For>
                    </div>
                    <div class="flex flex-wrap gap-1">
                      <For each={p().items} fallback={<span class="text-xs text-ink-500">No items yet</span>}>
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
              <Show when={frame()}>
                {(f) => (
                  <>
                    <ObjectiveStatus
                      urn={f().urn}
                      rift={f().rift}
                      midbossAlive={!!midboss()}
                      midbossHp={midboss() ? midboss()!.hp / Math.max(1, midboss()!.max_hp) : null}
                      midbossRespawn={f().midboss_respawn_in_s ?? null}
                      camps={campCounts()}
                      powerups={(f().powerups ?? []).map((p) => p.kind ?? null)}
                      carrier={tag}
                      carrierTeam={urnCarrierTeam()}
                      assets={assets.data}
                    />
                    <Show when={f().rift}>{(r) => <RiftCapturers rift={r()} assets={assets.data} />}</Show>
                  </>
                )}
              </Show>
              <Tabs
                value={tab()}
                onChange={setTab}
                options={[
                  { value: 'events', label: 'Events' },
                  { value: 'stats', label: 'Stats' },
                  { value: 'builds', label: 'Builds' },
                  { value: 'souls', label: 'Souls' },
                ]}
              />
              <Show when={tab() === 'events'}>
                <div class="flex flex-wrap gap-1">
                  <For each={Object.entries(EVENT_GROUPS) as [EventGroup, string][]}>
                    {([key, label]) => (
                      <button
                        class={`rounded-full px-2.5 py-0.5 text-[11px] font-medium ring-1 transition-colors ${filter() === key ? 'bg-gold-500/15 text-gold-300 ring-gold-500/40' : 'text-ink-400 ring-ink-700 hover:text-ink-200'}`}
                        onClick={() => setFilter(key)}
                      >
                        {label}
                      </button>
                    )}
                  </For>
                </div>
                <ol class="flex max-h-[520px] flex-col gap-1 overflow-y-auto pr-1">
                  <For each={events()} fallback={<li class="py-8 text-center text-xs text-ink-500">Kills, purchases, abilities, objectives, the urn and the rift show up here.</li>}>
                    {(e) => (
                      <li class="flex items-center gap-2 rounded-lg bg-ink-850 px-2.5 py-1.5 text-xs">
                        <span class="tabular w-10 shrink-0 font-mono text-ink-500">{clock(e.time_s)}</span>
                        <span class="grid w-5 shrink-0 place-items-center">{eventIcon(e)}</span>
                        <span class="flex min-w-0 flex-1 items-center gap-1 overflow-hidden text-ink-200" title={describe(e, heroName, abilityName)}>
                          {eventText(e, tag)}
                        </span>
                        {eventExtra(e, assets.data)}
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
                          <Index each={players().filter((p) => p.team === team)}>
                            {(p) => (
                              <li
                                class={`flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-xs ${selected() === p().account_id ? 'bg-gold-500/10 ring-1 ring-gold-500/40' : 'bg-ink-850 hover:bg-ink-800'}`}
                                onClick={() => setSelected(p().account_id)}
                                title={`Last hits ${p().last_hits ?? '–'} · denies ${p().denies ?? '–'} · hero damage ${p().hero_damage ?? '–'}`}
                              >
                                <HeroIcon assets={assets.data} heroId={p().hero_id} class="size-7" dim={!p().alive} />
                                <div class="min-w-0 flex-1">
                                  <div class="flex items-center gap-1">
                                    <span class="truncate text-ink-100">{name(p().account_id)}</span>
                                    <RankBadge assets={assets.data} badge={names().get(p().account_id)?.badge} />
                                  </div>
                                  <div class="mt-0.5 h-1 overflow-hidden rounded bg-ink-700">
                                    <div class="h-full bg-win" style={{ width: `${p().max_hp ? Math.round(((p().hp ?? 0) / (p().max_hp ?? 1)) * 100) : 0}%` }} />
                                  </div>
                                </div>
                                <span class="tabular w-8 text-right text-ink-400">Lv{p().level}</span>
                                <span class="tabular w-14 text-right text-ink-200">{p().kills}/{p().deaths}/{p().assists}</span>
                                <span class="tabular w-10 text-right text-gold-300">{compact(p().net_worth)}</span>
                              </li>
                            )}
                          </Index>
                        </ul>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
              <Show when={tab() === 'builds'}>
                <div class="flex max-h-[600px] flex-col gap-3 overflow-y-auto pr-1">
                  <For each={[0, 1] as const}>
                    {(team) => (
                      <div>
                        <p class={`mb-1 text-xs font-bold uppercase tracking-wider ${TEAM_TEXT[team]}`}>{TEAM_NAMES[team]}</p>
                        <ul class="flex flex-col gap-1">
                          <Index each={players().filter((p) => p.team === team)}>
                            {(p) => (
                              <li
                                class={`flex cursor-pointer flex-col gap-1.5 rounded-lg px-2 py-1.5 text-xs ${selected() === p().account_id ? 'bg-gold-500/10 ring-1 ring-gold-500/40' : 'bg-ink-850 hover:bg-ink-800'}`}
                                onClick={() => setSelected(p().account_id)}
                              >
                                <div class="flex items-center gap-2">
                                  <HeroIcon assets={assets.data} heroId={p().hero_id} class="size-7" dim={!p().alive} />
                                  <div class="min-w-0 flex-1">
                                    <p class="truncate text-ink-100">{name(p().account_id)}</p>
                                    <p class="tabular text-[11px] text-ink-400">Lv{p().level} · {p().items.length} items</p>
                                  </div>
                                  <AbilityRow abilities={p().abilities} assets={assets.data} />
                                </div>
                                <div class="flex flex-wrap gap-0.5">
                                  <For each={p().items}>
                                    {(id) => (
                                      <Show when={itemOf(assets.data, id)}>
                                        {(it) => <img src={it().image ?? ''} alt={it().name} title={it().name} class="size-5 rounded bg-ink-800" loading="lazy" />}
                                      </Show>
                                    )}
                                  </For>
                                </div>
                              </li>
                            )}
                          </Index>
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
