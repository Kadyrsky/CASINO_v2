/**
 * Wallet-page card for MetaMask + Sepolia: connect (lab module 04), link the address by signing a message,
 * deposit test ETH (lab module 05). Tokens are credited by the core once the deposit is a few blocks deep.
 */
import { createQuery, useQueryClient } from '@tanstack/solid-query';
import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js';
import { del, get, post } from '../api/client';
import type { EthStatus } from '../api/types';
import { eth, etherscanAddress, etherscanTx, explainEthError, shortAddress } from '../lib/eth';
import { ago, tokens } from '../lib/format';
import { toast } from './toast';
import { Badge, Button, Card, Field, Input, Spinner } from './ui';

type Notice = { text: string; kind: 'info' | 'error' | 'success' };

const NOTICE_CLASS: Record<Notice['kind'], string> = {
  info: 'text-ink-300',
  error: 'text-loss',
  success: 'text-win',
};

const STATUS_TONE = { credited: 'win', unlinked: 'warn', held: 'warn' } as const;

export function EthWallet() {
  const queryClient = useQueryClient();
  const [waitingFor, setWaitingFor] = createSignal<string | null>(null);
  const status = createQuery(() => ({
    queryKey: ['eth'],
    queryFn: () => get<EthStatus>('/api/wallet/eth'),
    refetchInterval: waitingFor() ? 5_000 : false,
  }));
  const [busy, setBusy] = createSignal(false);
  const [notice, setNotice] = createSignal<Notice | null>(null);
  const [txHash, setTxHash] = createSignal<string | null>(null);
  const [amount, setAmount] = createSignal('0.001');
  const [limits, setLimits] = createSignal<{ min: string; max: string } | null>(null);

  onCleanup(
    eth.onChange(() => {
      setLimits(null);
      setNotice({ text: 'The wallet changed. Reconnect.', kind: 'info' });
    }),
  );

  // While a deposit is on its way, poll until the core has seen it, then report the outcome once.
  createEffect(() => {
    const hash = waitingFor()?.toLowerCase();
    const seen = hash ? status.data?.deposits.find((d) => d.txHash === hash) : undefined;
    if (!seen) return;
    setWaitingFor(null);
    if (seen.status === 'credited') {
      toast.success(`+${tokens(seen.amountTokens)} NTK from your Sepolia deposit`);
      setNotice({ text: 'Deposit credited.', kind: 'success' });
      void queryClient.invalidateQueries({ queryKey: ['transactions'] });
      void queryClient.invalidateQueries({ queryKey: ['limits'] });
      void queryClient.invalidateQueries({ queryKey: ['kyc'] }); // the KYC banner shows lifetime deposits
    } else {
      setNotice({ text: `Deposit received but not credited: ${seen.holdReason ?? 'no account is linked to the sender'}.`, kind: 'error' });
    }
  });

  // Disable further clicks during an operation; finally always re-enables them (as run() in the lab).
  async function run(action: () => Promise<void>) {
    if (busy()) return;
    setBusy(true);
    try {
      await action();
    } catch (e) {
      setNotice({ text: explainEthError(e), kind: 'error' });
    } finally {
      setBusy(false);
    }
  }

  const linked = () => status.data?.linkedAddress ?? null;
  const connectedIsLinked = () => !!eth.account() && eth.account()!.toLowerCase() === linked();
  const previewTokens = () => {
    const n = Number(amount());
    return Number.isFinite(n) && n > 0 ? n * (status.data?.tokensPerEth ?? 0) : 0;
  };

  const connect = () =>
    run(async () => {
      setNotice({ text: 'Allow the website to connect in MetaMask.', kind: 'info' });
      await eth.connect();
      setNotice({ text: 'Connected to Sepolia.', kind: 'success' });
      const contract = status.data?.contractAddress;
      if (contract) setLimits(await eth.depositLimits(contract));
    });

  const switchNetwork = () =>
    run(async () => {
      await eth.switchToSepolia();
      setNotice({ text: 'Sepolia selected. Reconnect.', kind: 'info' });
    });

  const link = () =>
    run(async () => {
      const address = eth.account();
      if (!address) throw new Error('Connect MetaMask first.');
      const { message } = await post<{ message: string }>('/api/wallet/eth/link-message', { address });
      setNotice({ text: 'Sign the message in MetaMask. Signing is free and sends no transaction.', kind: 'info' });
      const signature = await eth.signMessage(message);
      queryClient.setQueryData(['eth'], await post<EthStatus>('/api/wallet/eth/link', { signature }));
      void queryClient.invalidateQueries({ queryKey: ['transactions'] }); // earlier deposits may have been credited now
      setNotice({ text: 'Address linked. Deposits from it now credit this account.', kind: 'success' });
    });

  const unlink = () =>
    run(async () => {
      await del('/api/wallet/eth/link');
      await queryClient.invalidateQueries({ queryKey: ['eth'] });
      setNotice({ text: 'Address unlinked. New deposits from it will wait until an account links it.', kind: 'info' });
    });

  const deposit = (e: Event) => {
    e.preventDefault();
    void run(async () => {
      const contract = status.data?.contractAddress;
      if (!contract) throw new Error('Sepolia deposits are not configured.');
      setTxHash(null);
      setNotice({ text: 'Approve the transaction in MetaMask.', kind: 'info' });
      await eth.deposit(contract, amount(), (hash) => {
        setTxHash(hash);
        setNotice({ text: 'Submitted. Waiting for block inclusion…', kind: 'info' });
      });
      setWaitingFor(txHash());
      setNotice({
        text: `Included in a block. Tokens arrive after ${status.data?.confirmations ?? 3} confirmations (about a minute).`,
        kind: 'success',
      });
    });
  };

  return (
    <Card title="Sepolia test ETH" actions={<Badge tone="blue">Web3 · MetaMask</Badge>} class="scroll-mt-24">
      <div id="sepolia" class="flex flex-col gap-4 p-4 text-sm">
        <Show when={!status.isLoading} fallback={<div class="grid place-items-center py-6"><Spinner /></div>}>
          <Show
            when={status.data?.enabled}
            fallback={
              <p class="text-ink-400">
                Sepolia deposits are off. Deploy <code>contracts/NaebkaCashier.sol</code> from Remix and set{' '}
                <code>NAEBKA_ETH_CONTRACT_ADDRESS</code> (see the README).
              </p>
            }
          >
            <p class="text-ink-400">
              Deposit Sepolia test ETH to get play tokens: 0.001 ETH = {tokens((status.data?.tokensPerEth ?? 0) / 1000)} NTK. Test ETH has no
              value. Get some from a{' '}
              <a class="text-gold-300 hover:underline" href="https://ethereum.org/developers/docs/networks/" target="_blank" rel="noreferrer">
                Sepolia faucet
              </a>
              .
            </p>

            <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
              <dt class="text-ink-400">Network</dt>
              <dd class={eth.onSepolia() ? 'text-win' : 'text-ink-200'}>{eth.network()}</dd>
              <dt class="text-ink-400">MetaMask account</dt>
              <dd class="tabular truncate text-ink-200" title={eth.account() ?? ''}>{shortAddress(eth.account())}</dd>
              <dt class="text-ink-400">Linked address</dt>
              <dd class="tabular truncate">
                <Show when={linked()} fallback={<span class="text-ink-400">None yet</span>}>
                  {(a) => (
                    <a class="text-gold-300 hover:underline" href={etherscanAddress(a())} target="_blank" rel="noreferrer" title={a()}>
                      {shortAddress(a())}
                    </a>
                  )}
                </Show>
              </dd>
              <dt class="text-ink-400">Cashier contract</dt>
              <dd class="tabular truncate">
                <a class="text-gold-300 hover:underline" href={etherscanAddress(status.data!.contractAddress!)} target="_blank" rel="noreferrer">
                  {shortAddress(status.data!.contractAddress)}
                </a>
              </dd>
            </dl>

            <div class="flex flex-wrap gap-2">
              <Button size="sm" onClick={connect} loading={busy()} variant={eth.account() ? 'secondary' : 'primary'}>
                {eth.account() ? 'Reconnect' : 'Connect MetaMask'}
              </Button>
              <Button size="sm" variant="ghost" onClick={switchNetwork} disabled={busy()}>Switch to Sepolia</Button>
              <Show when={eth.account() && !connectedIsLinked()}>
                <Button size="sm" variant="secondary" onClick={link} disabled={busy()}>
                  {linked() ? 'Link this account instead' : 'Link this address'}
                </Button>
              </Show>
              <Show when={linked()}>
                <Button size="sm" variant="ghost" onClick={unlink} disabled={busy()}>Unlink</Button>
              </Show>
            </div>

            <Show when={!eth.available()}>
              <p class="text-warn">MetaMask was not found. Use the browser with the extension installed.</p>
            </Show>

            <Show when={connectedIsLinked() && eth.onSepolia()}>
              <form class="flex items-end gap-2" onSubmit={deposit}>
                <Field
                  label="Deposit (ETH)"
                  class="flex-1"
                  hint={
                    <>
                      = {tokens(previewTokens())} NTK
                      <Show when={limits()}>{(l) => <> · contract allows {l().min}–{l().max} ETH</>}</Show>
                    </>
                  }
                >
                  <Input type="text" inputmode="decimal" required value={amount()} onInput={(ev) => setAmount(ev.currentTarget.value)} />
                </Field>
                <Button type="submit" loading={busy()}>Deposit</Button>
              </form>
            </Show>

            <Show when={notice()}>
              {(n) => <p class={NOTICE_CLASS[n().kind]} role="status">{n().text}</p>}
            </Show>
            <Show when={txHash()}>
              {(h) => (
                <a class="text-gold-300 hover:underline" href={etherscanTx(h())} target="_blank" rel="noreferrer">
                  View the transaction on Etherscan ↗
                </a>
              )}
            </Show>

            <Show when={status.data?.deposits.length}>
              <ul class="divide-y divide-ink-800 rounded-lg bg-ink-850">
                <For each={status.data?.deposits}>
                  {(d) => (
                    <li class="flex items-center justify-between gap-3 px-3 py-2">
                      <div class="min-w-0">
                        <a class="tabular font-medium hover:underline" href={etherscanTx(d.txHash)} target="_blank" rel="noreferrer">
                          {d.amountEth} ETH
                        </a>
                        <p class="truncate text-xs text-ink-400" title={d.holdReason ?? ''}>
                          {ago(d.createdAt)}
                          <Show when={d.holdReason}> · {d.holdReason}</Show>
                        </p>
                      </div>
                      <div class="flex shrink-0 items-center gap-2">
                        <Show when={d.amountTokens != null}>
                          <span class="tabular text-win">+{tokens(d.amountTokens)} NTK</span>
                        </Show>
                        <Badge tone={STATUS_TONE[d.status]}>{d.status}</Badge>
                      </div>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </Show>
        </Show>
      </div>
    </Card>
  );
}
