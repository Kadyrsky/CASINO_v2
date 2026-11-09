/**
 * Custom component registry: the shared building blocks every page uses, so spacing, colours and
 * interaction states stay consistent while each game keeps its own look.
 */
import { type JSX, Show, splitProps, createEffect, onCleanup, For } from 'solid-js';
import { Portal } from 'solid-js/web';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';

const variants: Record<Variant, string> = {
  primary: 'btn-dl bg-gold-500 text-ink-950 hover:bg-gold-400 shadow-[0_6px_24px_-8px_color-mix(in_oklab,var(--color-gold-500)_60%,transparent)]',
  secondary: 'bg-ink-700 text-ink-100 hover:bg-ink-600 border border-ink-600',
  ghost: 'text-ink-200 hover:bg-ink-800 hover:text-ink-100',
  danger: 'bg-loss/90 text-white hover:bg-loss',
  success: 'bg-win/90 text-ink-950 hover:bg-win',
};

export function Button(
  props: JSX.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg'; loading?: boolean },
) {
  const [local, rest] = splitProps(props, ['variant', 'size', 'loading', 'class', 'children', 'disabled']);
  const size = () =>
    ({ sm: 'h-8 px-3 text-sm', md: 'h-10 px-4 text-sm', lg: 'h-12 px-6 text-base' })[local.size ?? 'md'];
  return (
    <button
      {...rest}
      disabled={local.disabled || local.loading}
      class={`dl-type inline-flex items-center justify-center gap-2 rounded-lg font-semibold transition-all duration-150 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-45 disabled:active:scale-100 ${variants[local.variant ?? 'primary']} ${size()} ${local.class ?? ''}`}
    >
      <Show when={local.loading}>
        <Spinner class="size-4" />
      </Show>
      {local.children}
    </button>
  );
}

export function Spinner(props: { class?: string }) {
  return (
    <svg class={`animate-spin ${props.class ?? 'size-5'}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-opacity="0.25" stroke-width="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="3" stroke-linecap="round" />
    </svg>
  );
}

export function Card(props: { class?: string; children: JSX.Element; title?: JSX.Element; actions?: JSX.Element }) {
  return (
    <section class={`dl-panel rounded-[var(--radius-card)] border border-ink-700/70 bg-ink-900/80 backdrop-blur ${props.class ?? ''}`}>
      <Show when={props.title || props.actions}>
        <header class="flex items-center justify-between gap-3 border-b border-ink-700/60 px-4 py-3">
          <h2 class="text-sm font-semibold tracking-wide text-ink-200">{props.title}</h2>
          {props.actions}
        </header>
      </Show>
      {props.children}
    </section>
  );
}

type Tone = 'neutral' | 'gold' | 'win' | 'loss' | 'warn' | 'live' | 'blue';

const tones: Record<Tone, string> = {
  neutral: 'bg-ink-700 text-ink-200',
  gold: 'bg-gold-500/15 text-gold-300 ring-1 ring-gold-500/30',
  win: 'bg-win/15 text-win ring-1 ring-win/30',
  loss: 'bg-loss/15 text-loss ring-1 ring-loss/30',
  warn: 'bg-warn/15 text-warn ring-1 ring-warn/30',
  live: 'bg-loss/15 text-loss ring-1 ring-loss/40',
  blue: 'bg-sapphire-team/15 text-sapphire-team ring-1 ring-sapphire-team/30',
};

export function Badge(props: { tone?: Tone; children: JSX.Element; class?: string; pulse?: boolean }) {
  return (
    <span
      class={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider ${tones[props.tone ?? 'neutral']} ${props.class ?? ''}`}
    >
      <Show when={props.pulse}>
        <span class="size-1.5 animate-pulse-soft rounded-full bg-current" />
      </Show>
      {props.children}
    </span>
  );
}

export function statusTone(status: string | null | undefined): Tone {
  switch (status) {
    case 'LIVE':
    case 'OPEN':
      return 'live';
    case 'WON':
    case 'SETTLED':
      return 'win';
    case 'LOST':
      return 'loss';
    case 'STALE':
    case 'SUSPENDED':
    case 'REVIEW':
    case 'PENDING':
      return 'warn';
    default:
      return 'neutral';
  }
}

export function Field(props: { label: string; hint?: JSX.Element; error?: string | null; children: JSX.Element; class?: string }) {
  return (
    <label class={`flex flex-col gap-1.5 ${props.class ?? ''}`}>
      <span class="text-xs font-semibold uppercase tracking-wider text-ink-400">{props.label}</span>
      {props.children}
      <Show when={props.error} fallback={<Show when={props.hint}><span class="text-xs text-ink-400">{props.hint}</span></Show>}>
        <span class="text-xs text-loss">{props.error}</span>
      </Show>
    </label>
  );
}

export function Input(props: JSX.InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  const [local, rest] = splitProps(props, ['class', 'invalid']);
  return (
    <input
      {...rest}
      aria-invalid={local.invalid}
      class={`h-10 w-full rounded-lg border bg-ink-950/60 px-3 text-sm text-ink-100 placeholder:text-ink-500 transition-colors focus:border-gold-500 focus:outline-none ${local.invalid ? 'border-loss' : 'border-ink-600'} ${local.class ?? ''}`}
    />
  );
}

export function Select(props: JSX.SelectHTMLAttributes<HTMLSelectElement>) {
  const [local, rest] = splitProps(props, ['class', 'children']);
  return (
    <select
      {...rest}
      class={`h-10 w-full rounded-lg border border-ink-600 bg-ink-950/60 px-3 text-sm text-ink-100 focus:border-gold-500 focus:outline-none ${local.class ?? ''}`}
    >
      {local.children}
    </select>
  );
}

export function Modal(props: { open: boolean; onClose: () => void; title: string; children: JSX.Element; footer?: JSX.Element }) {
  createEffect(() => {
    if (!props.open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose();
    document.addEventListener('keydown', onKey);
    onCleanup(() => document.removeEventListener('keydown', onKey));
  });
  return (
    <Show when={props.open}>
      <Portal>
        <div class="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 backdrop-blur-sm sm:items-center" onClick={props.onClose}>
          <div
            role="dialog"
            aria-modal="true"
            aria-label={props.title}
            class="w-full max-w-md animate-pop rounded-2xl border border-ink-600 bg-ink-900 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <header class="flex items-center justify-between border-b border-ink-700 px-5 py-4">
              <h3 class="font-semibold">{props.title}</h3>
              <button class="rounded-md p-1 text-ink-400 hover:bg-ink-800 hover:text-ink-100" onClick={props.onClose} aria-label="Close">
                ✕
              </button>
            </header>
            <div class="px-5 py-4">{props.children}</div>
            <Show when={props.footer}>
              <footer class="flex justify-end gap-2 border-t border-ink-700 px-5 py-3">{props.footer}</footer>
            </Show>
          </div>
        </div>
      </Portal>
    </Show>
  );
}

export function Empty(props: { title: string; children?: JSX.Element; icon?: string }) {
  return (
    <div class="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <div class="text-3xl opacity-60">{props.icon ?? '◇'}</div>
      <p class="font-semibold text-ink-200">{props.title}</p>
      <Show when={props.children}>
        <div class="max-w-sm text-sm text-ink-400">{props.children}</div>
      </Show>
    </div>
  );
}

export function Stat(props: { label: string; value: JSX.Element; sub?: JSX.Element; class?: string }) {
  return (
    <div class={`flex flex-col gap-0.5 ${props.class ?? ''}`}>
      <span class="text-[11px] font-semibold uppercase tracking-wider text-ink-400">{props.label}</span>
      <span class="tabular text-lg font-bold">{props.value}</span>
      <Show when={props.sub}>
        <span class="tabular text-xs text-ink-400">{props.sub}</span>
      </Show>
    </div>
  );
}

export function Tabs<T extends string>(props: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[] }) {
  return (
    <div role="tablist" class="inline-flex rounded-lg bg-ink-850 p-1 ring-1 ring-ink-700">
      <For each={props.options}>
        {(o) => (
          <button
            role="tab"
            aria-selected={props.value === o.value}
            class={`dl-type rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${props.value === o.value ? 'bg-ink-700 text-ink-100 shadow' : 'text-ink-400 hover:text-ink-200'}`}
            onClick={() => props.onChange(o.value)}
          >
            {o.label}
          </button>
        )}
      </For>
    </div>
  );
}

export function PageHeader(props: { title: string; subtitle?: JSX.Element; actions?: JSX.Element }) {
  return (
    <div class="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 class="text-2xl font-extrabold tracking-tight sm:text-3xl">{props.title}</h1>
        <Show when={props.subtitle}>
          <p class="mt-1 text-sm text-ink-400">{props.subtitle}</p>
        </Show>
      </div>
      {props.actions}
    </div>
  );
}
