import { createEffect, createRoot, createSignal, onCleanup } from 'solid-js';
import { get } from '../api/client';
import type { Wallet } from '../api/types';
import { auth } from './auth';
import { hub } from './ws';

/** Live wallet balance: fetched once per login, then kept current by WALLET_UPDATED pushes. */
export const wallet = createRoot(() => {
  const [balance, setBalance] = createSignal<number | null>(null);
  const [flash, setFlash] = createSignal<'up' | 'down' | null>(null);

  const refresh = async () => {
    if (!auth.user()) return;
    try {
      setBalance((await get<Wallet>('/api/wallet')).balance);
    } catch {
      // shown as unknown until the next push
    }
  };

  createEffect(() => {
    const user = auth.user();
    setBalance(null);
    if (!user) return;
    void refresh();
    const off = hub.subscribe(`user:${user.id}`, (msg) => {
      if (msg.type !== 'WALLET_UPDATED') return;
      const data = msg.data as { balance: number; change: number };
      setBalance(data.balance);
      setFlash(data.change >= 0 ? 'up' : 'down');
      window.setTimeout(() => setFlash(null), 1200);
    });
    onCleanup(off);
  });

  return { balance, flash, refresh, set: setBalance };
});
