/**
 * Pieces of the realtime map added on top of heroes and objectives: neutral camps (with the Sinner's Sacrifices),
 * the Mid-Boss respawn, bridge power-ups, hero abilities and the map-objective status panel.
 *
 * Markers are drawn in the map's 0–1000 SVG space and scaled by the zoom ({@link MapScale}), so they keep their size
 * on screen when the map is zoomed in.
 */
import { createContext, For, Show, useContext, type JSX } from 'solid-js';
import type { CampKind, FrameAbility, FrameCamp, FrameRift, FrameSinner, FrameUrn, LiveAssets } from '../api/types';
import { clock, compact } from '../lib/format';
import { RIFT_ICON, TEAM_COLOR, TEAM_NAMES, TEAM_TEXT, URN_ICON, abilityOf, heroOf } from '../lib/live';

/** Marker scale: 1 at the full map, smaller when zoomed in. */
export const MapScale = createContext<() => number>(() => 1);

/** How long each kind of camp stays down (measured on live broadcasts), for the countdown ring. */
export const CAMP_RESPAWN_S: Record<CampKind, number> = { weak: 85, medium: 290, strong: 335, vault: 300 };
export const MIDBOSS_RESPAWN_S = 420;

export const CAMP_LABEL: Record<CampKind, string> = {
  weak: 'Small camp',
  medium: 'Medium camp',
  strong: 'Hard camp',
  vault: "Sinner's Sacrifice",
};

const CAMP_COLOR = '#8fc7ae'; // the in-game minimap's camp green
const SINNER_COLOR = '#e879a6';
const DOWN_COLOR = '#5b5573';
const POWERUP_COLOR = '#67d4f5';

/**
 * The kind of each camp in a frame, found by position in the map assets (the frame's timers stand exactly on
 * deadlock-api's camp positions). Cached per camp id; unknown camps count as medium.
 */
export function campKinds(assets: LiveAssets | undefined) {
  const cache = new Map<number, CampKind>();
  return (c: FrameCamp): CampKind => {
    const hit = cache.get(c.id);
    if (hit) return hit;
    let best: CampKind = 'medium';
    let bestD = 250 * 250;
    for (const a of assets?.map.camps ?? []) {
      const d = (a.x - c.x) ** 2 + (a.y - c.y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = a.kind;
      }
    }
    if (assets?.map.camps?.length) cache.set(c.id, best);
    return best;
  };
}

/** The in-game camp glyphs: a triangle with 0–2 bars for weak to hard camps, a ringed square for a Sinner's Sacrifice. */
function CampGlyph(props: { kind: CampKind; fill: string }) {
  return (
    <Show
      when={props.kind !== 'vault'}
      fallback={
        <g>
          <rect x="-7" y="-7" width="14" height="14" rx="2.5" fill={props.fill} stroke="#0b0a10" stroke-width="2" />
          <circle r="3.2" fill="none" stroke="#0b0a10" stroke-width="2" />
        </g>
      }
    >
      {(() => {
        const bars = props.kind === 'strong' ? 2 : props.kind === 'medium' ? 1 : 0;
        const top = -4 - bars * 2.5;
        return (
          <g stroke="#0b0a10" stroke-width="1.6" stroke-linejoin="round">
            <path d={`M0 ${top - 5} L6 ${top + 4} L-6 ${top + 4} Z`} fill={props.fill} />
            <For each={Array.from({ length: bars }, (_, i) => i)}>
              {(i) => <rect x="-6" y={top + 5.5 + i * 4.5} width="12" height="3.4" rx="1" fill={props.fill} />}
            </For>
          </g>
        );
      })()}
    </Show>
  );
}

/** A countdown ring (time left of the full respawn) with the time under it. */
function Countdown(props: { left: number; total: number; r: number }) {
  const share = () => Math.max(0, Math.min(1, props.left / props.total));
  return (
    <>
      <circle r={props.r} fill="rgb(11 10 16 / 0.75)" stroke="#2a2638" stroke-width="2.5" />
      <circle
        r={props.r}
        fill="none"
        stroke="var(--color-ink-300)"
        stroke-width="2.5"
        pathLength="100"
        stroke-dasharray={`${share() * 100} 100`}
        transform="rotate(-90)"
      />
      <text y={props.r + 11} text-anchor="middle" class="fill-ink-200 text-[10px] font-semibold tabular" paint-order="stroke" stroke="#0b0a10" stroke-width="3">
        {clock(props.left)}
      </text>
    </>
  );
}

export function CampMarker(props: { camp: FrameCamp; kind: CampKind; sinner?: FrameSinner; at: [number, number] }) {
  const k = useContext(MapScale);
  const down = () => props.camp.respawn_in_s != null && props.camp.respawn_in_s > 0;
  const color = () => (down() ? DOWN_COLOR : props.kind === 'vault' ? SINNER_COLOR : CAMP_COLOR);
  const hurt = () => (props.sinner && props.sinner.hp < props.sinner.max_hp ? props.sinner.hp / props.sinner.max_hp : null);
  const title = () => {
    const name = CAMP_LABEL[props.kind];
    if (down()) return `${name} · back in ${clock(props.camp.respawn_in_s)}`;
    if (props.sinner && hurt() != null) return `${name} · ${props.sinner.hp}/${props.sinner.max_hp} being sacrificed`;
    return `${name} · up`;
  };
  return (
    <g transform={`translate(${props.at[0] * 1000} ${props.at[1] * 1000}) scale(${k()})`} class="pointer-events-auto">
      <title>{title()}</title>
      <Show when={down()}>
        <Countdown left={props.camp.respawn_in_s!} total={CAMP_RESPAWN_S[props.kind]} r={11} />
      </Show>
      <g opacity={down() ? 0.8 : 1} transform={down() ? 'scale(0.75)' : undefined}>
        <CampGlyph kind={props.kind} fill={color()} />
      </g>
      <Show when={!down() && hurt() != null}>
        <rect x="-10" y="11" width="20" height="3.5" rx="1.5" fill="rgb(0 0 0 / 0.75)" />
        <rect x="-10" y="11" width={20 * hurt()!} height="3.5" rx="1.5" fill={SINNER_COLOR} />
      </Show>
    </g>
  );
}

/** The dead Mid-Boss's spot with its respawn countdown. */
export function MidbossTimer(props: { left: number; at: [number, number] }) {
  const k = useContext(MapScale);
  return (
    <g transform={`translate(${props.at[0] * 1000} ${props.at[1] * 1000}) scale(${k()})`}>
      <title>{`Mid-Boss · back in ${clock(props.left)}`}</title>
      <Countdown left={props.left} total={MIDBOSS_RESPAWN_S} r={17} />
      <image href="/icons/objectives/midboss.webp" x="-11" y="-11" width="22" height="22" opacity="0.55" filter="url(#grey)" />
    </g>
  );
}

/** A bridge power-up waiting to be picked up. */
export function PowerupMarker(props: { at: [number, number] }) {
  const k = useContext(MapScale);
  return (
    <g transform={`translate(${props.at[0] * 1000} ${props.at[1] * 1000}) scale(${k()})`}>
      <title>Bridge power-up</title>
      <PowerupGlyph />
    </g>
  );
}

/** An ability icon: grey while locked, with its ability points (of 3) as pips under it. */
export function AbilityIcon(props: { ability: FrameAbility; assets?: LiveAssets; size?: 'sm' | 'md'; ultimate?: boolean }) {
  const info = () => abilityOf(props.assets, props.ability.id);
  const px = () => (props.size === 'md' ? 'size-9' : 'size-6');
  const state = () => (props.ability.unlocked ? `${props.ability.tier} of 3 points` : 'locked');
  return (
    <span class="inline-flex flex-col items-center gap-0.5" title={`${info()?.name ?? 'Ability'} · ${state()}`}>
      <span
        class={`relative grid ${px()} place-items-center overflow-hidden rounded-md bg-ink-800 ${props.ultimate ? 'ring-1 ring-gold-500/60' : 'ring-1 ring-ink-700'}`}
      >
        <Show when={info()?.image} fallback={<span class="text-[9px] text-ink-500">?</span>}>
          {(src) => (
            <img
              src={src()}
              alt={info()?.name ?? ''}
              loading="lazy"
              class={`size-full object-contain p-0.5 ${props.ability.unlocked ? '' : 'opacity-30 grayscale'}`}
            />
          )}
        </Show>
        <Show when={!props.ability.unlocked}>
          <span class="absolute inset-0 grid place-items-center text-[10px]">🔒</span>
        </Show>
      </span>
      <span class="flex gap-0.5">
        <For each={[1, 2, 3]}>
          {(i) => <span class={`h-1 w-1.5 rounded-full ${props.ability.unlocked && i <= props.ability.tier ? 'bg-gold-400' : 'bg-ink-700'}`} />}
        </For>
      </span>
    </span>
  );
}

export function AbilityRow(props: { abilities?: FrameAbility[]; assets?: LiveAssets; size?: 'sm' | 'md' }) {
  return (
    <Show when={props.abilities?.length} fallback={<span class="text-[11px] text-ink-500">No ability data yet</span>}>
      <span class="flex items-start gap-1">
        <For each={props.abilities}>
          {(a, i) => <AbilityIcon ability={a} assets={props.assets} size={props.size} ultimate={i() === (props.abilities?.length ?? 0) - 1} />}
        </For>
      </span>
    </Show>
  );
}

function Tile(props: { icon: JSX.Element; label: string; children: JSX.Element; active?: boolean }) {
  return (
    <div class={`flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 ${props.active ? 'bg-ink-800 ring-1 ring-gold-500/30' : 'bg-ink-850'}`}>
      <span class="grid size-6 shrink-0 place-items-center">{props.icon}</span>
      <div class="min-w-0 flex-1 leading-tight">
        <p class="text-[10px] font-semibold uppercase tracking-wider text-ink-500">{props.label}</p>
        <div class="truncate text-xs text-ink-200">{props.children}</div>
      </div>
    </div>
  );
}

/** The rift's two spots are left and right of the middle of the map, as drawn. */
function side(x: number): string {
  return x < 0 ? 'left side' : 'right side';
}

/**
 * The state of the map objectives a bettor cares about: the Soul Urn, the Unstable Rift, the Mid-Boss, camps and
 * Sinner's Sacrifices, and the bridge power-ups.
 */
export function ObjectiveStatus(props: {
  urn?: FrameUrn | null;
  rift?: FrameRift | null;
  midbossAlive: boolean;
  midbossHp: number | null;
  midbossRespawn: number | null;
  camps: { up: number; total: number; sinnersUp: number; sinners: number };
  powerups: number;
  carrier: (id: number) => JSX.Element;
  carrierTeam: 0 | 1 | null;
  assets?: LiveAssets;
}) {
  const img = (src: string, color: string) => (
    <img src={src} alt="" class="size-6 rounded-md bg-ink-950 object-contain p-0.5" style={{ 'box-shadow': `0 0 0 1.5px ${color}` }} />
  );
  return (
    <div class="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
      <Tile icon={img(URN_ICON, props.carrierTeam != null ? TEAM_COLOR[props.carrierTeam] : '#f5c451')} label="Soul Urn" active={!!props.urn}>
        <Show when={props.urn} fallback={<span class="text-ink-500">Not in play</span>}>
          {(u) => (
            <Show when={u().carrier != null} fallback={<>On the ground{u().value ? ` · ${compact(u().value)} souls` : ''}</>}>
              <span class="inline-flex min-w-0 items-center gap-1">
                {props.carrier(u().carrier!)}
                <span class="shrink-0 text-ink-400">carrying{u().value ? ` · ${compact(u().value)}` : ''}</span>
              </span>
            </Show>
          )}
        </Show>
      </Tile>
      <Tile icon={img(RIFT_ICON, '#4fd1c5')} label="Unstable Rift" active={!!props.rift?.open}>
        <Show when={props.rift} fallback={<span class="text-ink-500">Not in play</span>}>
          {(r) => (
            <Show
              when={r().open}
              fallback={<>Opens {r().opens_in_s != null ? `in ${clock(r().opens_in_s)}` : 'soon'} · {side(r().x)}</>}
            >
              <span class="tabular">
                <span class={TEAM_TEXT[0]}>{Math.round(r().progress[0] * 100)}%</span>
                {' · '}
                <span class={TEAM_TEXT[1]}>{Math.round(r().progress[1] * 100)}%</span>
                <Show when={r().contested}>
                  <span class="text-warn"> · contested</span>
                </Show>
                <Show when={r().closes_in_s != null}>
                  <span class="text-ink-400"> · {clock(r().closes_in_s)}</span>
                </Show>
              </span>
            </Show>
          )}
        </Show>
      </Tile>
      <Tile icon={img('/icons/objectives/midboss.webp', '#b07cff')} label="Mid-Boss" active={props.midbossAlive && (props.midbossHp ?? 1) < 1}>
        <Show
          when={props.midbossAlive}
          fallback={
            <Show when={props.midbossRespawn != null} fallback={<span class="text-ink-500">Down</span>}>
              Back in {clock(props.midbossRespawn)}
            </Show>
          }
        >
          Alive{props.midbossHp != null && props.midbossHp < 1 ? ` · ${Math.round(props.midbossHp * 100)}% health` : ''}
        </Show>
      </Tile>
      <Tile
        icon={
          <svg viewBox="-12 -12 24 24" class="size-6">
            <CampGlyph kind="vault" fill={SINNER_COLOR} />
          </svg>
        }
        label="Camps"
      >
        <span class="tabular">
          {props.camps.up}/{props.camps.total} up · <span style={{ color: SINNER_COLOR }}>{props.camps.sinnersUp}/{props.camps.sinners}</span> sinners
        </span>
      </Tile>
      <Show when={props.powerups > 0}>
        <Tile
          icon={
            <svg viewBox="-12 -12 24 24" class="size-6">
              <PowerupGlyph />
            </svg>
          }
          label="Bridge power-ups"
          active
        >
          {props.powerups} waiting
        </Tile>
      </Show>
    </div>
  );
}

function PowerupGlyph() {
  return (
    <>
      <circle r="11" fill="#0b0a10" stroke={POWERUP_COLOR} stroke-width="2.5" />
      <path d="M1.5 -7 L-4.5 1 L-0.5 1 L-1.5 7 L4.5 -1 L0.5 -1 Z" fill={POWERUP_COLOR} />
    </>
  );
}

/** Hero portraits of the players on the rift, per team. */
export function RiftCapturers(props: { rift: FrameRift; assets?: LiveAssets }) {
  return (
    <Show when={props.rift.open && (props.rift.heroes?.[0].length || props.rift.heroes?.[1].length)}>
      <div class="flex items-center justify-between gap-2 rounded-lg bg-ink-850 px-2 py-1.5 text-xs">
        <For each={[0, 1] as const}>
          {(team) => (
            <span class="flex items-center gap-1">
              <span class={`text-[10px] font-semibold uppercase ${TEAM_TEXT[team]}`}>{TEAM_NAMES[team]}</span>
              <For each={props.rift.heroes?.[team] ?? []}>
                {(id) => (
                  <img
                    src={heroOf(props.assets, id)?.icon ?? ''}
                    alt={heroOf(props.assets, id)?.name ?? ''}
                    title={heroOf(props.assets, id)?.name ?? ''}
                    class="size-5 rounded bg-ink-800"
                  />
                )}
              </For>
            </span>
          )}
        </For>
      </div>
    </Show>
  );
}
