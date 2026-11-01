import { A } from '@solidjs/router';
import { createQuery } from '@tanstack/solid-query';
import { For, Show } from 'solid-js';
import { get } from '../api/client';
import type { PokerTableInfo } from '../api/types';
import { Badge, Card, Empty, PageHeader, Spinner } from '../components/ui';
import { tokens } from '../lib/format';

export default function PokerLobby() {
  const tables = createQuery(() => ({
    queryKey: ['poker-tables'],
    queryFn: () => get<PokerTableInfo[]>('/api/poker/tables'),
    refetchInterval: 5_000,
  }));
  return (
    <div>
      <PageHeader title="Poker" subtitle="No-Limit Texas Hold'em cash tables against other players. 5% rake, no flop no drop." />
      <Show when={!tables.isLoading} fallback={<div class="grid place-items-center py-24"><Spinner class="size-8" /></div>}>
        <Show when={tables.data?.length} fallback={<Card><Empty title={tables.isError ? 'Could not load tables' : 'No tables open'} icon={tables.isError ? '⚠' : '◇'}>{tables.isError ? 'The server is unreachable — retrying automatically.' : undefined}</Empty></Card>}>
          <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <For each={tables.data}>
              {(t) => (
                <A
                  href={`/poker/${t.id}`}
                  class="group relative overflow-hidden rounded-[var(--radius-card)] border border-ink-700/70 bg-ink-900/80 p-5 transition-all hover:-translate-y-0.5 hover:border-felt-700"
                >
                  <div class="absolute -right-10 -top-10 size-32 rounded-full bg-felt-700/30 blur-2xl transition-opacity group-hover:opacity-100" />
                  <div class="relative flex items-start justify-between">
                    <div>
                      <h2 class="text-lg font-bold">{t.name}</h2>
                      <p class="tabular text-sm text-ink-400">Blinds {tokens(t.smallBlind)} / {tokens(t.bigBlind)}</p>
                    </div>
                    <Show when={t.handInProgress} fallback={<Badge>Waiting</Badge>}>
                      <Badge tone="win" pulse>In play</Badge>
                    </Show>
                  </div>
                  <div class="relative mt-5 flex items-end justify-between">
                    <div class="flex gap-1">
                      <For each={Array.from({ length: t.maxSeats }, (_, i) => i)}>
                        {(i) => <span class={`size-3 rounded-full ${i < t.seated ? 'bg-win' : 'bg-ink-700'}`} />}
                      </For>
                    </div>
                    <span class="text-xs text-ink-400">{t.seated}/{t.maxSeats} seated</span>
                  </div>
                  <p class="relative mt-3 text-xs text-ink-400">Buy-in {tokens(t.minBuyIn)} – {tokens(t.maxBuyIn)} NTK</p>
                </A>
              )}
            </For>
          </div>
        </Show>
      </Show>
    </div>
  );
}
