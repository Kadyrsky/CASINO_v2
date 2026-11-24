/**
 * Markers of the realtime map, shared by its 2D and 2.5D views: heroes, objectives, the Unstable Rift and the Soul Urn.
 *
 * They are drawn in SVG around their `at` point (0–1 map position, times 1000) and scaled by {@link MapScale}: the 2D
 * map passes map positions; the 2.5D view passes [0, 0] inside a group it places on the screen itself.
 */
import { For, Show, useContext } from 'solid-js';
import type { FrameObjective, FramePlayer, FrameRift, LiveAssets } from '../api/types';
import { clock } from '../lib/format';
import { RIFT_ICON, TEAM_COLOR, TEAM_NAMES, URN_ICON, heroOf, objectiveIcon } from '../lib/live';
import { MapScale } from './liveMapLayers';

/** Radius of each objective's icon (map units; heroes are 17). */
export const OBJECTIVE_SIZE: Record<FrameObjective['kind'], number> = {
  guardian: 12,
  walker: 16,
  base_guardian: 10,
  patron: 18,
  patron_core: 15,
  midboss: 15,
};

/** Glyphs (patrons, Mid-Boss) sit inside the disc; the guardian and walker pictures fill it. */
export const isGlyph = (kind: FrameObjective['kind']) => kind === 'patron' || kind === 'patron_core' || kind === 'midboss';

export function objectiveColor(kind: FrameObjective['kind'], team: 0 | 1 | null): string {
  return kind === 'midboss' ? '#b07cff' : team == null ? '#8a83a3' : TEAM_COLOR[team];
}

/**
 * Objectives are rounded squares, so they never look like the round hero markers. The outline is the health left,
 * running clockwise from the top left corner.
 */
export function ObjectiveMarker(props: { o: FrameObjective; at: [number, number] }) {
  const s = () => OBJECTIVE_SIZE[props.o.kind] ?? 10;
  const color = () => objectiveColor(props.o.kind, props.o.team);
  const share = () => (props.o.max_hp > 0 ? Math.min(1, props.o.hp / props.o.max_hp) : 1);
  const outer = () => s() + 4;
  // Glyphs are a little smaller than the square, so the dark edge frames them; pictures fill it.
  const img = () => (isGlyph(props.o.kind) ? s() * 0.8 : s());
  const k = useContext(MapScale);
  return (
    <g transform={`translate(${props.at[0] * 1000} ${props.at[1] * 1000}) scale(${k()})`}>
      <title>{`${props.o.kind.replace('_', ' ')} · ${Math.round(share() * 100)}%`}</title>
      <rect x={-outer()} y={-outer()} width={outer() * 2} height={outer() * 2} rx={outer() * 0.35} fill="#0b0a10" stroke="rgb(0 0 0 / 0.5)" stroke-width="3" />
      <rect
        x={-outer()}
        y={-outer()}
        width={outer() * 2}
        height={outer() * 2}
        rx={outer() * 0.35}
        fill="none"
        stroke={color()}
        stroke-width="3"
        pathLength="100"
        stroke-dasharray={`${share() * 100} 100`}
      />
      <Show
        when={objectiveIcon(props.o.kind, props.o.team)}
        fallback={<rect x={-s() / 2} y={-s() / 2} width={s()} height={s()} transform="rotate(45)" fill={color()} />}
      >
        {(src) => (
          <image href={src()} x={-img()} y={-img()} width={img() * 2} height={img() * 2} clip-path="url(#rounded)" preserveAspectRatio="xMidYMid slice" />
        )}
      </Show>
    </g>
  );
}

export const RIFT_COLOR = '#4fd1c5';
export const URN_COLOR = '#f5c451';

/**
 * The Unstable Rift: dimmed with a dashed outline and a countdown while it appears, then open with each team's
 * capture progress as a bar below it (Hidden King on top), a pulsing ring while both teams contest it, and the time
 * left before it closes.
 */
export function RiftMarker(props: { r: FrameRift; at: [number, number] }) {
  const k = useContext(MapScale);
  const s = 16;
  const outer = s + 4;
  const title = () => {
    if (!props.r.open) return `Unstable Rift · opens${props.r.opens_in_s != null ? ` in ${clock(props.r.opens_in_s)}` : ' soon'}`;
    const pct = props.r.progress.map((p) => `${Math.round(p * 100)}%`);
    const left = props.r.closes_in_s != null ? ` · closes in ${clock(props.r.closes_in_s)}` : '';
    return `Unstable Rift · ${TEAM_NAMES[0]} ${pct[0]}, ${TEAM_NAMES[1]} ${pct[1]}${props.r.contested ? ' · contested' : ''}${left}`;
  };
  const label = (text: string, y: number, fill: string) => (
    <text y={y} text-anchor="middle" fill={fill} class="text-[11px] font-semibold tabular" paint-order="stroke" stroke="#0b0a10" stroke-width="3.5">
      {text}
    </text>
  );
  return (
    <g transform={`translate(${props.at[0] * 1000} ${props.at[1] * 1000}) scale(${k()})`} opacity={props.r.open ? 1 : 0.8}>
      <title>{title()}</title>
      <Show when={props.r.open && props.r.contested}>
        <rect
          x={-outer - 6}
          y={-outer - 6}
          width={outer * 2 + 12}
          height={outer * 2 + 12}
          rx={outer * 0.5}
          fill="none"
          stroke="var(--color-warn)"
          stroke-width="2.5"
          class="animate-pulse-soft"
        />
      </Show>
      <rect
        x={-outer}
        y={-outer}
        width={outer * 2}
        height={outer * 2}
        rx={outer * 0.35}
        fill="#0b0a10"
        stroke={RIFT_COLOR}
        stroke-width="3"
        stroke-dasharray={props.r.open ? undefined : '6 5'}
      />
      <image href={RIFT_ICON} x={-s * 0.8} y={-s * 0.8} width={s * 1.6} height={s * 1.6} />
      <Show when={!props.r.open && props.r.opens_in_s != null}>{label(clock(props.r.opens_in_s), -outer - 6, RIFT_COLOR)}</Show>
      <Show when={props.r.open}>
        <For each={[0, 1] as const}>
          {(team) => (
            <>
              <rect x={-outer} y={outer + 4 + team * 7} width={outer * 2} height="5" rx="2" fill="rgb(0 0 0 / 0.7)" />
              <rect x={-outer} y={outer + 4 + team * 7} width={outer * 2 * props.r.progress[team]} height="5" rx="2" fill={TEAM_COLOR[team]} />
            </>
          )}
        </For>
        <Show when={props.r.closes_in_s != null}>{label(clock(props.r.closes_in_s), -outer - 6, 'var(--color-ink-100)')}</Show>
      </Show>
    </g>
  );
}

/** The Soul Urn lying on the ground. */
export function UrnMarker(props: { at: [number, number]; value?: number | null }) {
  const k = useContext(MapScale);
  const s = 13;
  const outer = s + 4;
  return (
    <g transform={`translate(${props.at[0] * 1000} ${props.at[1] * 1000}) scale(${k()})`}>
      <title>{`Soul Urn${props.value ? ` · ${props.value} souls` : ''}`}</title>
      <rect x={-outer} y={-outer} width={outer * 2} height={outer * 2} rx={outer * 0.35} fill="#0b0a10" stroke={URN_COLOR} stroke-width="3" />
      <image href={URN_ICON} x={-s * 0.85} y={-s * 0.85} width={s * 1.7} height={s * 1.7} />
    </g>
  );
}

/** Where the carried urn has to go: a dashed ring in the carrier's team colour. */
export function UrnDelivery(props: { at: [number, number]; color: string }) {
  const k = useContext(MapScale);
  return (
    <g transform={`translate(${props.at[0] * 1000} ${props.at[1] * 1000}) scale(${k()})`}>
      <title>Soul Urn delivery point</title>
      <circle r="22" fill="rgb(11 10 16 / 0.6)" stroke={props.color} stroke-width="3" stroke-dasharray="7 5" />
      <image href={URN_ICON} x="-12" y="-12" width="24" height="24" opacity="0.6" />
    </g>
  );
}

/** A small urn on the carrier's hero marker (drawn above the heroes, top right of the carrier). */
export function UrnCarried(props: { at: [number, number] }) {
  const k = useContext(MapScale);
  return (
    <g transform={`translate(${props.at[0] * 1000} ${props.at[1] * 1000}) scale(${k()}) translate(15 -15)`} class="pointer-events-none">
      <circle r="10" fill="#0b0a10" stroke={URN_COLOR} stroke-width="2.5" />
      <image href={URN_ICON} x="-7.5" y="-7.5" width="15" height="15" />
    </g>
  );
}

export function HeroMarker(props: {
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
  const k = useContext(MapScale);
  return (
    <Show when={props.at}>
      {(at) => (
        <g
          transform={`translate(${at()[0] * 1000} ${at()[1] * 1000}) scale(${k()})`}
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
          <Show when={props.p.alive && props.p.ult_ready}>
            <circle cx="13" cy="-13" r="4.5" fill="var(--color-gold-400)" stroke="#0b0a10" stroke-width="2">
              <title>Ultimate ready</title>
            </circle>
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
