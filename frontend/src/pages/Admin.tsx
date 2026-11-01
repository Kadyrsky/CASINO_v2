import { A } from '@solidjs/router';
import { createQuery, useQueryClient } from '@tanstack/solid-query';
import { createSignal, For, Show } from 'solid-js';
import { get, post } from '../api/client';
import type { KycSubmission, Match } from '../api/types';
import { KycChecks } from '../components/kyc';
import { toast } from '../components/toast';
import { Badge, Button, Card, Empty, Input, PageHeader, Stat } from '../components/ui';
import { ago, countryName, humanize } from '../lib/format';

interface Health {
  watcherHeartbeat: string | null;
  oddsEngineHeartbeat: string | null;
  deadlockApiBreaker: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  matchesByStatus: Record<string, number>;
  ledgerDrift: { walletId: string; balance: number; ledger: number }[];
}

function ReviewItem(props: { match: Match; onDone: () => void }) {
  const [duration, setDuration] = createSignal('1800');
  const [busy, setBusy] = createSignal(false);
  const settle = async (winnerSide: 1 | 2) => {
    setBusy(true);
    try {
      await post(`/api/admin/matches/${props.match.id}/settle`, { winnerSide, durationSeconds: Number(duration()) });
      toast.success('Match settled');
      props.onDone();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const voidMatch = async () => {
    setBusy(true);
    try {
      await post(`/api/admin/matches/${props.match.id}/void`);
      toast.success('Match voided, stakes refunded');
      props.onDone();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <li class="flex flex-col gap-3 px-4 py-4">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <A href={`/matches/${props.match.id}`} class="font-semibold hover:text-gold-300">Match #{props.match.externalId}</A>
          <p class="text-xs text-ink-400">ended {ago(props.match.endedAt)} · {humanize(props.match.reviewReason)}</p>
        </div>
        <a class="text-xs text-gold-300 hover:underline" href={`https://deadlock-api.com/matches/${props.match.externalId}`} target="_blank" rel="noreferrer">
          Check the source ↗
        </a>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <Input class="w-32" type="number" value={duration()} onInput={(e) => setDuration(e.currentTarget.value)} aria-label="Duration in seconds" />
        <span class="text-xs text-ink-400">seconds</span>
        <Button size="sm" loading={busy()} onClick={() => settle(1)}>Hidden King won</Button>
        <Button size="sm" loading={busy()} onClick={() => settle(2)}>Archmother won</Button>
        <Button size="sm" variant="danger" loading={busy()} onClick={voidMatch}>Void & refund</Button>
      </div>
    </li>
  );
}

/** One flagged KYC submission: the identity details and why the automatic checks flagged it. */
function KycReviewItem(props: { submission: KycSubmission; onDone: () => void }) {
  const [reason, setReason] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const s = () => props.submission;
  const decide = async (action: 'approve' | 'reject') => {
    setBusy(true);
    try {
      await post(`/api/admin/kyc/submissions/${s().id}/${action}`, action === 'reject' ? { reason: reason() } : undefined);
      toast.success(action === 'approve' ? `${s().username} verified` : `${s().username} rejected`);
      props.onDone();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const row = (label: string, value: string) => (
    <div class="contents">
      <dt class="text-ink-400">{label}</dt>
      <dd class="text-ink-200">{value}</dd>
    </div>
  );
  return (
    <li class="flex flex-col gap-3 px-4 py-4">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <p class="font-semibold">{s().firstName} {s().lastName} <span class="font-normal text-ink-400">@{s().username}</span></p>
        <span class="text-xs text-ink-400">submitted {ago(s().createdAt)}</span>
      </div>
      <div class="grid gap-4 md:grid-cols-2">
        <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          {row('Date of birth', s().dateOfBirth)}
          {row('Country', countryName(s().documentCountry))}
          {row('Document', `${humanize(s().documentType)} ···${s().documentNumberLast4}`)}
          {row('Expires', s().documentExpiry)}
        </dl>
        <KycChecks checks={s().checks} />
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="success" loading={busy()} onClick={() => decide('approve')}>Approve</Button>
        <Input class="min-w-48 flex-1" placeholder="Reason for rejection (shown to the player)" value={reason()} onInput={(e) => setReason(e.currentTarget.value)} />
        <Button size="sm" variant="danger" loading={busy()} disabled={!reason().trim()} onClick={() => decide('reject')}>Reject</Button>
      </div>
    </li>
  );
}

export default function Admin() {
  const queryClient = useQueryClient();
  const health = createQuery(() => ({ queryKey: ['admin-health'], queryFn: () => get<Health>('/api/admin/health'), refetchInterval: 10_000 }));
  const queue = createQuery(() => ({ queryKey: ['review-queue'], queryFn: () => get<Match[]>('/api/admin/review-queue') }));
  const kycQueue = createQuery(() => ({ queryKey: ['kyc-queue'], queryFn: () => get<KycSubmission[]>('/api/admin/kyc/queue') }));
  const beat = (iso: string | null | undefined) => (iso ? (/^\d+$/.test(iso) ? ago(new Date(Number(iso) * 1000).toISOString()) : ago(iso)) : 'missing');
  return (
    <div>
      <PageHeader title="Integrity dashboard" subtitle="Fleet health, the settlement and KYC review queues and ledger reconciliation." />
      <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card class="p-4"><Stat label="Watcher heartbeat" value={beat(health.data?.watcherHeartbeat)} /></Card>
        <Card class="p-4"><Stat label="Odds engine heartbeat" value={beat(health.data?.oddsEngineHeartbeat)} /></Card>
        <Card class="p-4">
          <Stat label="Deadlock API breaker" value={<Badge tone={health.data?.deadlockApiBreaker === 'CLOSED' ? 'win' : 'loss'}>{health.data?.deadlockApiBreaker ?? '…'}</Badge>} />
        </Card>
        <Card class="p-4">
          <Stat
            label="Ledger drift"
            value={<Badge tone={health.data?.ledgerDrift.length ? 'loss' : 'win'}>{health.data?.ledgerDrift.length ? `${health.data.ledgerDrift.length} wallets` : 'None'}</Badge>}
            sub="balance vs Σ ledger rows"
          />
        </Card>
      </div>
      <div class="mt-4 flex flex-wrap gap-2">
        <For each={Object.entries(health.data?.matchesByStatus ?? {})}>
          {([status, n]) => <Badge>{status}: {n}</Badge>}
        </For>
      </div>
      <Card title="Manual review queue" class="mt-6">
        <Show when={queue.data?.length} fallback={<Empty title="Nothing to review" icon="✓">Matches land here when the live stream and the official report disagree.</Empty>}>
          <ul class="divide-y divide-ink-800">
            <For each={queue.data}>
              {(m) => <ReviewItem match={m} onDone={() => void queryClient.invalidateQueries({ queryKey: ['review-queue'] })} />}
            </For>
          </ul>
        </Show>
      </Card>
      <Card title="KYC review queue" class="mt-6" actions={<span class="text-xs text-ink-400">Flagged by the automatic checks</span>}>
        <Show when={kycQueue.data?.length} fallback={<Empty title="No identities to review" icon="✓">Submissions land here after a recent date-of-birth/country change or when a document is reused.</Empty>}>
          <ul class="divide-y divide-ink-800">
            <For each={kycQueue.data}>
              {(k) => <KycReviewItem submission={k} onDone={() => void queryClient.invalidateQueries({ queryKey: ['kyc-queue'] })} />}
            </For>
          </ul>
        </Show>
      </Card>
    </div>
  );
}
