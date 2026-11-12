/**
 * Small chart kit for the admin dashboard: plain SVG/HTML, no library. Follows one set of rules for every chart:
 * thin marks (bars <= 16px with a 4px rounded end, 2px lines, 8px dots with a surface ring), a 2px surface gap
 * between touching marks, recessive 1px grid, text in text colours (never the series colour), a legend whenever
 * there are two or more series, and a hover/focus tooltip on every mark. Every number shown here is also in the
 * Tables view, so nothing depends on hovering.
 *
 * Colours: a categorical palette (dark steps, validated for colour-blind separation and >= 3:1 contrast on the
 * panels of every theme), assigned in a fixed order and always to the same thing.
 */
import { createSignal, For, onCleanup, onMount, Show, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';

export const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181'] as const;
const SURFACE = 'var(--color-ink-900)';
const GRID = 'var(--color-ink-700)';
const MUTED = 'var(--color-ink-400)';
const INK = 'var(--color-ink-200)';

// ---- Tooltip (one for the whole page) ----

interface Tip {
  x: number;
  y: number;
  title: string;
  rows: { color?: string; label: string; value: string }[];
}

const [tip, setTip] = createSignal<Tip | null>(null);

function anchor(e: PointerEvent | FocusEvent): { x: number; y: number } {
  if ('clientX' in e) return { x: e.clientX, y: e.clientY };
  const r = (e.currentTarget as Element).getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top };
}

/** Handlers that show a tooltip on hover and keyboard focus. */
export function tipOn(content: () => Omit<Tip, 'x' | 'y'>) {
  const show = (e: PointerEvent | FocusEvent) => setTip({ ...anchor(e), ...content() });
  return { onPointerMove: show, onPointerEnter: show, onFocus: show, onPointerLeave: () => setTip(null), onBlur: () => setTip(null) };
}

export function ChartTooltip() {
  return (
    <Portal>
      <Show when={tip()}>
        {(t) => (
          <div
            role="tooltip"
            class="pointer-events-none fixed z-[70] min-w-36 max-w-64 rounded-lg border border-ink-600 bg-ink-950/95 px-3 py-2 text-xs shadow-xl"
            style={{
              left: `${Math.min(t().x + 14, window.innerWidth - 270)}px`,
              top: `${Math.max(8, t().y - 12 - 22 * (t().rows.length + 1))}px`,
            }}
          >
            <p class="mb-1 font-semibold text-ink-300">{t().title}</p>
            <For each={t().rows}>
              {(r) => (
                <p class="flex items-center gap-2">
                  <Show when={r.color}>
                    <span class="h-0.5 w-3 rounded" style={{ background: r.color }} />
                  </Show>
                  <span class="tabular font-semibold text-ink-100">{r.value}</span>
                  <span class="text-ink-400">{r.label}</span>
                </p>
              )}
            </For>
          </div>
        )}
      </Show>
    </Portal>
  );
}

// ---- Layout helpers ----

/** The width of an element, kept current, so SVG text stays crisp at any size. */
function useWidth(initial = 600): [(el: HTMLElement) => void, () => number] {
  const [width, setWidth] = createSignal(initial);
  let observer: ResizeObserver | undefined;
  onCleanup(() => observer?.disconnect());
  const ref = (el: HTMLElement) => {
    onMount(() => {
      setWidth(el.clientWidth || initial);
      observer = new ResizeObserver(() => setWidth(el.clientWidth || initial));
      observer.observe(el);
    });
  };
  return [ref, width];
}

/** Round axis maximum and ticks: 0, step, 2·step… with step in 1, 2, 5 × 10^k. */
function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const ticks: number[] = [];
  for (let v = 0; v < max + step; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return ticks;
}

const fmt = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}K` : n.toLocaleString('en-US'));

// ---- Pieces ----

export function StatTile(props: { label: string; value: JSX.Element; sub?: JSX.Element }) {
  return (
    <div class="rounded-xl bg-ink-850 px-4 py-3 ring-1 ring-ink-700">
      <p class="text-[11px] font-semibold uppercase tracking-wider text-ink-400">{props.label}</p>
      <p class="tabular mt-1 text-2xl font-bold text-ink-100">{props.value}</p>
      <Show when={props.sub}>
        <p class="mt-0.5 text-xs text-ink-400">{props.sub}</p>
      </Show>
    </div>
  );
}

export function Legend(props: { items: { label: string; color: string; shape?: 'rect' | 'line' }[] }) {
  return (
    <div class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-300">
      <For each={props.items}>
        {(i) => (
          <span class="flex items-center gap-1.5">
            <span class={i.shape === 'line' ? 'h-0.5 w-3.5 rounded' : 'size-2.5 rounded-sm'} style={{ background: i.color }} />
            {i.label}
          </span>
        )}
      </For>
    </div>
  );
}

export interface BarRow {
  key: string;
  label: string;
  value: number;
  /** The figure printed at the bar's tip. */
  display: string;
  color: string;
  /** Extra tooltip lines. */
  detail?: { label: string; value: string }[];
}

/** Ranked horizontal bars on one baseline: the way to compare parts with each other. */
export function BarList(props: { rows: BarRow[]; max?: number; empty?: string }) {
  const max = () => props.max ?? Math.max(1e-9, ...props.rows.map((r) => r.value));
  return (
    <Show when={props.rows.length} fallback={<p class="py-6 text-center text-xs text-ink-500">{props.empty ?? 'No data yet'}</p>}>
      <ul class="flex flex-col gap-2">
        <For each={props.rows}>
          {(r) => (
            <li
              tabindex="0"
              class="group grid grid-cols-1 items-center gap-x-3 gap-y-1 rounded-md px-1 py-0.5 outline-none hover:bg-ink-850 focus-visible:bg-ink-850 sm:grid-cols-[minmax(8rem,40%)_1fr]"
              {...tipOn(() => ({ title: r.label, rows: [{ color: r.color, label: '', value: r.display }, ...(r.detail ?? [])] }))}
            >
              <span class="truncate text-xs text-ink-200">{r.label}</span>
              <span class="flex items-center gap-2">
                <span class="h-3.5 flex-1">
                  <span
                    class="block h-full rounded-r transition-[filter] group-hover:brightness-125 group-focus-visible:brightness-125"
                    style={{ width: `${Math.max(r.value > 0 ? 1.5 : 0, (100 * r.value) / max())}%`, background: r.color }}
                  />
                </span>
                <span class="tabular w-14 shrink-0 text-right text-xs font-semibold text-ink-100">{r.display}</span>
              </span>
            </li>
          )}
        </For>
      </ul>
    </Show>
  );
}

/** Vertical columns from one baseline, value on each cap. */
export function Columns(props: { cols: { label: string; value: number; color: string; title?: string }[]; height?: number; unit?: string }) {
  const [ref, width] = useWidth(320);
  const h = () => props.height ?? 170;
  const m = { top: 18, bottom: 26, left: 8, right: 8 };
  const ticks = () => niceTicks(Math.max(...props.cols.map((c) => c.value), 0), 3);
  const top = () => ticks()[ticks().length - 1]!;
  const band = () => (width() - m.left - m.right) / Math.max(1, props.cols.length);
  const y = (v: number) => m.top + (h() - m.top - m.bottom) * (1 - v / top());
  return (
    <div ref={ref} class="w-full">
      <svg width={width()} height={h()} role="img" aria-label={props.cols.map((c) => `${c.title ?? c.label}: ${c.value}`).join(', ')}>
        <For each={ticks()}>
          {(t) => <line x1={m.left} x2={width() - m.right} y1={y(t)} y2={y(t)} stroke={GRID} stroke-width="1" />}
        </For>
        <For each={props.cols}>
          {(c, i) => {
            const bw = () => Math.min(24, band() - 2);
            const x = () => m.left + band() * i() + (band() - bw()) / 2;
            const r = () => Math.min(4, (h() - m.bottom - y(c.value)) / 2);
            const path = () => {
              const x0 = x();
              const x1 = x0 + bw();
              const y0 = y(c.value);
              const yb = h() - m.bottom;
              if (c.value <= 0) return '';
              return `M${x0},${yb} V${y0 + r()} Q${x0},${y0} ${x0 + r()},${y0} H${x1 - r()} Q${x1},${y0} ${x1},${y0 + r()} V${yb} Z`;
            };
            return (
              <g
                tabindex="0"
                class="outline-none [&:focus-visible_path]:brightness-125 [&:hover_path]:brightness-125"
                {...tipOn(() => ({ title: c.title ?? c.label, rows: [{ color: c.color, label: props.unit ?? '', value: fmt(c.value) }] }))}
              >
                <rect x={m.left + band() * i()} y={m.top} width={band()} height={h() - m.top} fill="transparent" />
                <path d={path()} fill={c.color} />
                <text x={x() + bw() / 2} y={y(c.value) - 5} text-anchor="middle" font-size="11" font-weight="600" fill={INK}>
                  {c.value > 0 ? fmt(c.value) : ''}
                </text>
                <text x={x() + bw() / 2} y={h() - 8} text-anchor="middle" font-size="13" fill={MUTED}>
                  {c.label}
                </text>
              </g>
            );
          }}
        </For>
        <line x1={m.left} x2={width() - m.right} y1={h() - m.bottom} y2={h() - m.bottom} stroke={GRID} stroke-width="1" />
      </svg>
    </div>
  );
}

/** One whole split into a few parts (<= 5), read at a glance; the legend beside it carries the figures. */
export function Donut(props: { parts: { label: string; value: number; color: string }[]; centre: string; centreSub: string }) {
  const R = 46;
  const W = 13;
  const total = () => props.parts.reduce((s, p) => s + p.value, 0);
  const arcs = () => {
    const out: { label: string; value: number; color: string; d: string }[] = [];
    const shown = props.parts.filter((p) => p.value > 0);
    const gap = shown.length > 1 ? 2.5 / R : 0;
    let a = -Math.PI / 2;
    for (const p of shown) {
      const span = (2 * Math.PI * p.value) / total();
      const a0 = a + gap / 2;
      const a1 = a + span - gap / 2;
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const pt = (ang: number) => `${60 + R * Math.cos(ang)},${60 + R * Math.sin(ang)}`;
      const d = span >= 2 * Math.PI - 1e-6
        ? `M60,${60 - R} A${R},${R} 0 1 1 59.99,${60 - R}`
        : `M${pt(a0)} A${R},${R} 0 ${large} 1 ${pt(a1)}`;
      out.push({ ...p, d });
      a += span;
    }
    return out;
  };
  return (
    <div class="flex flex-wrap items-center gap-4">
      <svg width="120" height="120" viewBox="0 0 120 120" role="img" aria-label={props.parts.map((p) => `${p.label}: ${p.value}`).join(', ')} class="shrink-0">
        <circle cx="60" cy="60" r={R} fill="none" stroke={GRID} stroke-width={W} opacity={total() ? 0 : 1} />
        <For each={arcs()}>
          {(a) => (
            <path
              d={a.d}
              fill="none"
              stroke={a.color}
              stroke-width={W}
              tabindex="0"
              class="outline-none transition-[filter] hover:brightness-125 focus-visible:brightness-125"
              {...tipOn(() => ({ title: a.label, rows: [{ color: a.color, label: `of ${fmt(total())}`, value: `${fmt(a.value)} (${Math.round((100 * a.value) / total())}%)` }] }))}
            />
          )}
        </For>
        <text x="60" y="58" text-anchor="middle" font-size="20" font-weight="700" fill="var(--color-ink-100)">
          {props.centre}
        </text>
        <text x="60" y="75" text-anchor="middle" font-size="10" fill={MUTED}>
          {props.centreSub}
        </text>
      </svg>
      <ul class="flex min-w-[11rem] flex-1 flex-col gap-1 text-xs">
        <For each={props.parts}>
          {(p) => (
            <li class="flex items-center gap-2">
              <span class="size-2.5 shrink-0 rounded-sm" style={{ background: p.color }} />
              <span class="min-w-0 flex-1 truncate text-ink-200">{p.label}</span>
              <span class="tabular font-semibold text-ink-100">{fmt(p.value)}</span>
              <span class="tabular w-9 text-right text-ink-400">{total() ? `${Math.round((100 * p.value) / total())}%` : '–'}</span>
            </li>
          )}
        </For>
      </ul>
    </div>
  );
}

/** Lines over time on one axis, with a crosshair that snaps to the nearest point and lists every series. */
export function LineChart(props: { x: string[]; series: { label: string; color: string; values: number[] }[]; height?: number; title: string }) {
  const [ref, width] = useWidth(640);
  const [hover, setHover] = createSignal<number | null>(null);
  const h = () => props.height ?? 220;
  const m = { top: 12, right: 14, bottom: 26, left: 40 };
  const n = () => props.x.length;
  const ticks = () => niceTicks(Math.max(0, ...props.series.flatMap((s) => s.values)), 4);
  const top = () => ticks()[ticks().length - 1]!;
  const px = (i: number) => m.left + (n() < 2 ? (width() - m.left - m.right) / 2 : ((width() - m.left - m.right) * i) / (n() - 1));
  const py = (v: number) => m.top + (h() - m.top - m.bottom) * (1 - v / top());
  const labelEvery = () => Math.max(1, Math.ceil(n() / Math.max(2, Math.floor(width() / 90))));
  const showAt = (i: number, e: PointerEvent | FocusEvent | KeyboardEvent) => {
    setHover(i);
    const r = (e.currentTarget as Element).getBoundingClientRect();
    setTip({
      x: r.left + px(i),
      y: r.top + py(Math.max(...props.series.map((s) => s.values[i] ?? 0))),
      title: props.x[i] ?? '',
      rows: props.series.map((s) => ({ color: s.color, label: s.label, value: fmt(s.values[i] ?? 0) })),
    });
  };
  const nearest = (e: PointerEvent) => {
    const r = (e.currentTarget as Element).getBoundingClientRect();
    const t = (e.clientX - r.left - m.left) / Math.max(1, width() - m.left - m.right);
    return Math.max(0, Math.min(n() - 1, Math.round(t * (n() - 1))));
  };
  return (
    <div ref={ref} class="w-full">
      <svg
        width={width()}
        height={h()}
        role="img"
        aria-label={props.title}
        tabindex="0"
        class="outline-none"
        onPointerMove={(e) => showAt(nearest(e), e)}
        onPointerLeave={() => {
          setHover(null);
          setTip(null);
        }}
        onFocus={(e) => showAt(hover() ?? n() - 1, e)}
        onBlur={() => {
          setHover(null);
          setTip(null);
        }}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
          e.preventDefault();
          showAt(Math.max(0, Math.min(n() - 1, (hover() ?? n() - 1) + (e.key === 'ArrowLeft' ? -1 : 1))), e);
        }}
      >
        <For each={ticks()}>
          {(t) => (
            <>
              <line x1={m.left} x2={width() - m.right} y1={py(t)} y2={py(t)} stroke={GRID} stroke-width="1" />
              <text x={m.left - 6} y={py(t) + 4} text-anchor="end" font-size="11" fill={MUTED}>
                {fmt(t)}
              </text>
            </>
          )}
        </For>
        <For each={props.x}>
          {(label, i) => (
            <Show when={i() % labelEvery() === 0 || i() === n() - 1}>
              <text x={px(i())} y={h() - 8} text-anchor={i() === 0 ? 'start' : i() === n() - 1 ? 'end' : 'middle'} font-size="11" fill={MUTED}>
                {label}
              </text>
            </Show>
          )}
        </For>
        <Show when={hover() != null}>
          <line x1={px(hover()!)} x2={px(hover()!)} y1={m.top} y2={h() - m.bottom} stroke="var(--color-ink-500)" stroke-width="1" />
        </Show>
        <For each={props.series}>
          {(s) => (
            <polyline
              points={s.values.map((v, i) => `${px(i)},${py(v)}`).join(' ')}
              fill="none"
              stroke={s.color}
              stroke-width="2"
              stroke-linejoin="round"
              stroke-linecap="round"
            />
          )}
        </For>
        <Show when={hover() != null}>
          <For each={props.series}>
            {(s) => <circle cx={px(hover()!)} cy={py(s.values[hover()!] ?? 0)} r="4" fill={s.color} stroke={SURFACE} stroke-width="2" />}
          </For>
        </Show>
        {/* The last point of each line, so a short series still shows where it ends. */}
        <For each={props.series}>
          {(s) => <Show when={hover() == null && n() > 0}><circle cx={px(n() - 1)} cy={py(s.values[n() - 1] ?? 0)} r="4" fill={s.color} stroke={SURFACE} stroke-width="2" /></Show>}
        </For>
      </svg>
    </div>
  );
}
