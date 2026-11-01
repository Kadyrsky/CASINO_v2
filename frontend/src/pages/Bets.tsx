import { A } from '@solidjs/router';
import { createInfiniteQuery, useQueryClient } from '@tanstack/solid-query';
import { For, Show } from 'solid-js';
import { get } from '../api/client';
import type { Bet, Page } from '../api/types';
import { Badge, Button, Card, Empty, PageHeader, Spinner, statusTone } from '../components/ui';
import { auth } from '../lib/auth';
import { dateTime, fiat, humanize, odds, tokens } from '../lib/format';
import { useTopic } from '../lib/ws';

export default function Bets() {
  const queryClient = useQueryClient();
  const bets = createInfiniteQuery(() => ({
    queryKey: ['bets'],
    queryFn: ({ pageParam }) => get<Page<Bet>>('/api/bets', { cursor: pageParam, limit: 20 }),
    initialPageParam: '' as string,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  }));
  useTopic(
    () => (auth.user() ? `user:${auth.user()!.id}` : null),
    (msg) => {
      if (msg.type === 'BET_SETTLED' || msg.type === 'BET_PLACED') void queryClient.invalidateQueries({ queryKey: ['bets'] });
    },
  );
  const all = () => bets.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div>
      <PageHeader title="My bets" subtitle="Open bets settle automatically once the official match result is confirmed." />
      <Card>
        <Show when={!bets.isLoading} fallback={<div class="grid place-items-center py-16"><Spinner /></div>}>
          <Show when={all().length} fallback={<Empty title="No bets yet" icon="🎟">Pick a live match and place your first bet.</Empty>}>
            <div class="overflow-x-auto">
              <table class="w-full min-w-[640px] text-sm">
                <thead class="text-left text-[11px] uppercase tracking-wider text-ink-400">
                  <tr class="border-b border-ink-700/60">
                    <th class="px-4 py-3 font-semibold">Selection</th>
                    <th class="px-4 py-3 font-semibold">Odds</th>
                    <th class="px-4 py-3 text-right font-semibold">Stake</th>
                    <th class="px-4 py-3 text-right font-semibold">Return</th>
                    <th class="px-4 py-3 font-semibold">Status</th>
                    <th class="px-4 py-3 font-semibold">Placed</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-ink-800">
                  <For each={all()}>
                    {(b) => (
                      <tr class="hover:bg-ink-850">
                        <td class="px-4 py-3">
                          <A href={`/matches/${b.matchId}`} class="font-semibold hover:text-gold-300">{b.selectionName}</A>
                          <p class="text-xs text-ink-400">{b.marketName} · #{b.matchExternalId}</p>
                        </td>
                        <td class="tabular px-4 py-3 font-semibold text-gold-300">{odds(b.odds)}</td>
                        <td class="tabular px-4 py-3 text-right">{tokens(b.stake)}</td>
                        <td class="tabular px-4 py-3 text-right">
                          <Show when={b.status === 'PENDING'} fallback={<span class={b.payout > 0 ? 'font-semibold text-win' : 'text-ink-400'}>{tokens(b.payout)}</span>}>
                            <span class="text-ink-300">{tokens(b.potentialPayout)}</span>
                            <span class="block text-[11px] text-ink-500">≈ {fiat(b.potentialPayout)}</span>
                          </Show>
                        </td>
                        <td class="px-4 py-3"><Badge tone={statusTone(b.status)}>{humanize(b.status)}</Badge></td>
                        <td class="px-4 py-3 text-xs text-ink-400">{dateTime(b.placedAt)}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
            <Show when={bets.hasNextPage}>
              <div class="border-t border-ink-700/60 p-3 text-center">
                <Button variant="ghost" loading={bets.isFetchingNextPage} onClick={() => bets.fetchNextPage()}>Load more</Button>
              </div>
            </Show>
          </Show>
        </Show>
      </Card>
    </div>
  );
}
