import { A, useNavigate } from '@solidjs/router';
import { createInfiniteQuery, createQuery, useQueryClient } from '@tanstack/solid-query';
import { createSignal, For, onMount, Show } from 'solid-js';
import { ApiError, del, get, newIdempotencyKey, post, put } from '../api/client';
import type { KycInfo, Limit, Page, SessionInfo, Transaction, Wallet } from '../api/types';
import { EthWallet } from '../components/EthWallet';
import { KYC_LABEL, KYC_TONE } from '../components/kyc';
import { toast } from '../components/toast';
import { Badge, Button, Card, Empty, Field, Input, Modal, PageHeader, Select, Spinner, Stat } from '../components/ui';
import { auth } from '../lib/auth';
import { ago, appConfig, dateTime, fiat, humanize, tokens } from '../lib/format';
import { wallet } from '../lib/wallet';


function MoneyForm(props: { kind: 'deposit' | 'withdrawal' }) {
  const queryClient = useQueryClient();
  const [amount, setAmount] = createSignal('100');
  const [busy, setBusy] = createSignal(false);
  let key = newIdempotencyKey();
  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    try {
      await post<Transaction>(`/api/wallet/${props.kind === 'deposit' ? 'deposits' : 'withdrawals'}`, { amountTokens: Number(amount()) }, key);
      toast.success(`${props.kind === 'deposit' ? 'Deposited' : 'Withdrew'} ${tokens(Number(amount()))} NTK`);
      key = newIdempotencyKey();
      void queryClient.invalidateQueries({ queryKey: ['transactions'] });
      void queryClient.invalidateQueries({ queryKey: ['limits'] });
      void queryClient.invalidateQueries({ queryKey: ['kyc'] });
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 0) key = newIdempotencyKey(); // keep the key only to retry a network failure
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form class="flex items-end gap-2" onSubmit={submit}>
      <Field label={props.kind === 'deposit' ? 'Deposit' : 'Withdraw'} class="flex-1">
        <Input type="number" min="0.01" step="0.01" required value={amount()} onInput={(e) => setAmount(e.currentTarget.value)} />
      </Field>
      <Button type="submit" variant={props.kind === 'deposit' ? 'primary' : 'secondary'} loading={busy()}>
        {props.kind === 'deposit' ? 'Add tokens' : 'Withdraw'}
      </Button>
    </form>
  );
}

/** Tiered limits: what the current verification level allows. */
function KycBanner() {
  const kyc = createQuery(() => ({ queryKey: ['kyc'], queryFn: () => get<KycInfo>('/api/kyc') }));
  return (
    <Show when={kyc.data}>
      {(info) => (
        <div class="mt-5 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-ink-850 px-3 py-2.5 text-sm">
          <div class="flex items-center gap-2">
            <Badge tone={KYC_TONE[info().status]}>{KYC_LABEL[info().status]}</Badge>
            <span class="text-ink-400">
              <Show when={info().status !== 'VERIFIED'} fallback="Withdrawals unlocked, no deposit cap.">
                Withdrawals locked · deposits {tokens(info().depositedTokens)} / {tokens(info().depositCapTokens)} NTK
              </Show>
            </span>
          </div>
          <Show when={info().status !== 'VERIFIED'}>
            <A href="/verification" class="font-semibold text-gold-300 hover:underline">
              {info().status === 'PENDING' ? 'View status' : 'Verify now'} →
            </A>
          </Show>
        </div>
      )}
    </Show>
  );
}

const TX_ICON: Record<string, string> = {
  DEPOSIT: '↓', WITHDRAWAL: '↑', BET_STAKE: '🎟', BET_PAYOUT: '🏆', BET_REFUND: '↺', SLOT_BET: '❖', SLOT_WIN: '❖',
  JACKPOT_WIN: '💰', POKER_BUY_IN: '♠', POKER_CASH_OUT: '♠', ADJUSTMENT: '✎',
};

function Transactions() {
  const txs = createInfiniteQuery(() => ({
    queryKey: ['transactions'],
    queryFn: ({ pageParam }) => get<Page<Transaction>>('/api/wallet/transactions', { cursor: pageParam, limit: 20 }),
    initialPageParam: '' as string,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  }));
  const all = () => txs.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <Card title="Ledger" actions={<span class="text-xs text-ink-400">Append-only history of every token movement</span>}>
      <Show when={!txs.isLoading} fallback={<div class="grid place-items-center py-12"><Spinner /></div>}>
        <Show when={all().length} fallback={<Empty title="No transactions" />}>
          <ul class="divide-y divide-ink-800">
            <For each={all()}>
              {(t) => (
                <li class="flex items-center gap-3 px-4 py-2.5 text-sm">
                  <span class="grid size-8 shrink-0 place-items-center rounded-full bg-ink-800 text-xs">{TX_ICON[t.type] ?? '·'}</span>
                  <div class="min-w-0 flex-1">
                    <p class="font-medium">{humanize(t.type)}</p>
                    <p class="text-xs text-ink-400" title={dateTime(t.createdAt)}>{ago(t.createdAt)}</p>
                  </div>
                  <div class="text-right">
                    <p class={`tabular font-semibold ${t.amount > 0 ? 'text-win' : 'text-ink-200'}`}>
                      {t.amount > 0 ? '+' : ''}{tokens(t.amount)}
                    </p>
                    <p class="tabular text-xs text-ink-500">bal {tokens(t.balanceAfter)}</p>
                  </div>
                </li>
              )}
            </For>
          </ul>
          <Show when={txs.hasNextPage}>
            <div class="border-t border-ink-700/60 p-3 text-center">
              <Button variant="ghost" loading={txs.isFetchingNextPage} onClick={() => txs.fetchNextPage()}>Load more</Button>
            </div>
          </Show>
        </Show>
      </Show>
    </Card>
  );
}

function Limits() {
  const queryClient = useQueryClient();
  const limits = createQuery(() => ({ queryKey: ['limits'], queryFn: () => get<Limit[]>('/api/rg/limits') }));
  const [form, setForm] = createSignal({ limitType: 'deposit', period: 'daily', amountTokens: '500' });
  const [busy, setBusy] = createSignal(false);
  const save = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    try {
      await put('/api/rg/limits', { ...form(), amountTokens: Number(form().amountTokens) });
      toast.success('Limit saved. Increases take effect after 24 hours.');
      void queryClient.invalidateQueries({ queryKey: ['limits'] });
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Responsible-gambling limits" class="scroll-mt-24">
      <div id="limits" class="flex flex-col gap-4 p-4">
        <p class="text-sm text-ink-400">
          Cap how much you can deposit, wager or lose per day, week or month. Lowering a limit applies immediately; raising it
          takes effect after a 24-hour cooling-off period.
        </p>
        <Show when={limits.data?.length}>
          <div class="grid gap-2 sm:grid-cols-2">
            <For each={limits.data}>
              {(l) => {
                const pct = () => (l.amountTokens ? Math.min(100, (l.usedTokens / l.amountTokens) * 100) : 0);
                return (
                  <div class="rounded-lg bg-ink-850 p-3">
                    <div class="flex items-center justify-between text-sm">
                      <span class="font-semibold">{humanize(l.period)} {l.limitType}</span>
                      <span class="tabular text-ink-300">{tokens(l.usedTokens)} / {l.amountTokens ? tokens(l.amountTokens) : '—'}</span>
                    </div>
                    <div class="mt-2 h-1.5 overflow-hidden rounded-full bg-ink-700">
                      <div class={`h-full rounded-full ${pct() > 85 ? 'bg-loss' : 'bg-gold-500'}`} style={{ width: `${pct()}%` }} />
                    </div>
                    <Show when={l.pendingAmountTokens}>
                      <p class="mt-1.5 text-[11px] text-warn">→ {tokens(l.pendingAmountTokens)} from {dateTime(l.pendingFrom)}</p>
                    </Show>
                  </div>
                );
              }}
            </For>
          </div>
        </Show>
        <form class="grid grid-cols-2 gap-2 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end" onSubmit={save}>
          <Field label="Type">
            <Select value={form().limitType} onChange={(e) => setForm({ ...form(), limitType: e.currentTarget.value })}>
              <option value="deposit">Deposit</option>
              <option value="wager">Wager</option>
              <option value="loss">Loss</option>
            </Select>
          </Field>
          <Field label="Period">
            <Select value={form().period} onChange={(e) => setForm({ ...form(), period: e.currentTarget.value })}>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </Select>
          </Field>
          <Field label="Amount (NTK)" class="col-span-2 sm:col-span-1">
            <Input type="number" min="1" step="1" value={form().amountTokens} onInput={(e) => setForm({ ...form(), amountTokens: e.currentTarget.value })} />
          </Field>
          <Button type="submit" class="col-span-2 sm:col-span-1" loading={busy()}>Set limit</Button>
        </form>
      </div>
    </Card>
  );
}

function SelfExclusion() {
  const navigate = useNavigate();
  const [open, setOpen] = createSignal(false);
  const [days, setDays] = createSignal('30');
  const [busy, setBusy] = createSignal(false);
  const confirm = async () => {
    setBusy(true);
    try {
      await post('/api/rg/self-exclusion', days() === 'permanent' ? { permanent: true } : { days: Number(days()), permanent: false });
      auth.clear(); // every session was revoked server-side
      navigate('/');
      toast.info('You are now self-excluded and have been logged out.');
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Take a break" class="scroll-mt-24">
      <div id="self-exclusion" class="flex flex-col gap-3 p-4 text-sm text-ink-400">
        <p>Self-exclusion locks betting, slots and poker for the chosen period. You will be logged out of every device. This cannot be undone early.</p>
        <div class="flex gap-2">
          <Select value={days()} onChange={(e) => setDays(e.currentTarget.value)} class="max-w-48">
            <option value="1">24 hours</option>
            <option value="7">7 days</option>
            <option value="30">30 days</option>
            <option value="180">6 months</option>
            <option value="permanent">Permanently</option>
          </Select>
          <Button variant="danger" onClick={() => setOpen(true)}>Self-exclude</Button>
        </div>
      </div>
      <Modal
        open={open()}
        onClose={() => setOpen(false)}
        title="Confirm self-exclusion"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="danger" loading={busy()} onClick={confirm}>Yes, exclude me</Button>
          </>
        }
      >
        <p class="text-sm text-ink-300">
          You will not be able to play {days() === 'permanent' ? 'ever again on this account' : `for ${days()} day(s)`}. Are you sure?
        </p>
      </Modal>
    </Card>
  );
}

function Sessions() {
  const queryClient = useQueryClient();
  const sessions = createQuery(() => ({ queryKey: ['sessions'], queryFn: () => get<SessionInfo[]>('/api/auth/sessions') }));
  const revoke = async (id: string) => {
    await del(`/api/auth/sessions/${id}`);
    void queryClient.invalidateQueries({ queryKey: ['sessions'] });
  };
  const revokeAll = async () => {
    await post('/api/auth/sessions/revoke-all');
    auth.clear();
  };
  return (
    <Card title="Active sessions" actions={<Button size="sm" variant="ghost" onClick={revokeAll}>Log out everywhere</Button>}>
      <ul class="divide-y divide-ink-800">
        <For each={sessions.data}>
          {(s) => (
            <li class="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
              <div class="min-w-0">
                <p class="truncate text-ink-200">{s.userAgent?.split(')')[0]?.split('(')[1] ?? s.userAgent ?? 'Unknown device'}</p>
                <p class="text-xs text-ink-400">{s.ipAddress} · signed in {ago(s.createdAt)}</p>
              </div>
              <Button size="sm" variant="ghost" onClick={() => revoke(s.id)}>Revoke</Button>
            </li>
          )}
        </For>
      </ul>
    </Card>
  );
}

export default function WalletPage() {
  const info = createQuery(() => ({ queryKey: ['wallet'], queryFn: () => get<Wallet>('/api/wallet') }));
  onMount(() => {
    if (location.hash) document.querySelector(location.hash)?.scrollIntoView({ behavior: 'smooth' });
  });
  return (
    <div>
      <PageHeader
        title="Wallet"
        subtitle={<Show when={appConfig()?.currencyMode === 'PLAY_MONEY'}><Badge tone="gold">Play money</Badge> Tokens are free and have no cash value.</Show>}
      />
      <div class="grid gap-6 lg:grid-cols-[1fr_1fr]">
        <div class="flex flex-col gap-6">
          <Card class="p-5">
            <div class="flex flex-wrap items-end justify-between gap-4">
              <Stat label="Balance" value={<span class="text-3xl text-gold-300">{tokens(wallet.balance() ?? info.data?.balance)} NTK</span>} sub={`≈ ${fiat(wallet.balance() ?? info.data?.balance)}`} />
              <span class="text-xs text-ink-400">1 NTK = {fiat(1)}</span>
            </div>
            <div class="mt-5 grid gap-4 sm:grid-cols-2">
              <MoneyForm kind="deposit" />
              <MoneyForm kind="withdrawal" />
            </div>
            <KycBanner />
          </Card>
          <EthWallet />
          <Limits />
          <SelfExclusion />
          <Sessions />
        </div>
        <Transactions />
      </div>
    </div>
  );
}
