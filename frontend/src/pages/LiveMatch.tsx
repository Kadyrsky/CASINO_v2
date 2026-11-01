/** /live/:id: any match of the in-game Watch tab, with both rosters and the realtime map. */
import { A, Navigate, useParams } from '@solidjs/router';
import { createQuery } from '@tanstack/solid-query';
import { Show } from 'solid-js';
import { get } from '../api/client';
import type { LiveMatchInfo } from '../api/types';
import { LiveMap } from '../components/LiveMap';
import { RankBadge, Roster, useElapsed } from '../components/live';
import { Badge, Card, Empty, Spinner } from '../components/ui';
import { clock, compact } from '../lib/format';
import { GAME_MODE_LABEL, MODE_LABEL, TEAM_NAMES, TEAM_TEXT, regionLabel, useLiveAssets } from '../lib/live';

export default function LiveMatchPage() {
  const params = useParams();
  const assets = useLiveAssets();
  const info = createQuery(() => ({
    queryKey: ['live', 'match', params.id, 'page'],
    queryFn: () => get<LiveMatchInfo>(`/api/live/matches/${params.id}`),
    refetchInterval: 30_000,
  }));
  const m = () => info.data?.match;
  const elapsed = useElapsed(() => m()?.start_time);

  return (
    <Show when={!info.isLoading} fallback={<div class="grid place-items-center py-24"><Spinner class="size-8 text-gold-400" /></div>}>
      <Show when={!info.isError} fallback={<Card><Empty title="This match is not live" icon="⌛">It may have ended or left the Watch tab.</Empty></Card>}>
        {/* A match with markets has its own page, with the same map plus betting. */}
        <Show when={!info.data?.bettableMatchId} fallback={<Navigate href={`/matches/${info.data!.bettableMatchId}`} />}>
          <div class="flex flex-col gap-6">
            <A href="/" class="text-sm text-ink-400 hover:text-ink-200">← All live matches</A>
            <Show when={m()}>
              {(match) => (
                <Card class="overflow-hidden">
                  <div class="flex flex-wrap items-center justify-between gap-2 border-b border-ink-700/60 px-5 py-3">
                    <div class="flex items-center gap-2">
                      <Badge tone="live" pulse>Live</Badge>
                      <span class={`text-xs font-bold uppercase tracking-wider ${match().match_mode === 'ranked' ? 'text-gold-300' : 'text-ink-300'}`}>
                        {MODE_LABEL[match().match_mode]}
                      </span>
                      <span class="text-xs text-ink-400">
                        {GAME_MODE_LABEL[match().game_mode]} · {regionLabel(match().region)} · #{match().match_id} · 👁 {match().spectators}
                      </span>
                    </div>
                    <span class="tabular font-mono text-lg font-bold text-ink-100">{clock(elapsed())}</span>
                  </div>
                  <div class="grid gap-6 p-5 md:grid-cols-2">
                    {([0, 1] as const).map((team) => (
                      <div>
                        <div class={`mb-2 flex items-center gap-2 ${team === 1 ? 'flex-row-reverse text-right' : ''}`}>
                          <RankBadge assets={assets.data} badge={match().team_badges[team]} size="lg" />
                          <div>
                            <p class={`text-lg font-extrabold ${TEAM_TEXT[team]}`}>{TEAM_NAMES[team]}</p>
                            <p class="tabular text-xs text-ink-400">
                              {compact(match().net_worth[team])} souls · {match().objectives_alive[team]} objectives
                            </p>
                          </div>
                        </div>
                        <Roster assets={assets.data} players={match().players} team={team} />
                      </div>
                    ))}
                  </div>
                </Card>
              )}
            </Show>
            <LiveMap externalId={params.id!} roster={m()?.players} />
          </div>
        </Show>
      </Show>
    </Show>
  );
}
