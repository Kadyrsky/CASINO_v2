import { createRoot, createSignal } from 'solid-js';
import { configureClient, get, post } from '../api/client';
import type { TokenResponse, User } from '../api/types';
import { hub } from './ws';

const STORAGE_KEY = 'naebka.session';

interface Stored {
  token: string;
  expiresAt: string;
  user: User;
}

function load(): Stored | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Stored;
    return new Date(s.expiresAt).getTime() > Date.now() ? s : null;
  } catch {
    return null;
  }
}

function save(s: Stored | null) {
  try {
    if (s) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // storage unavailable (private mode): the session just won't survive a reload
  }
}

export const auth = createRoot(() => {
  const [session, setSession] = createSignal<Stored | null>(load());
  let refreshTimer: number | undefined;

  const apply = (r: TokenResponse | null) => {
    const s = r ? { token: r.token, expiresAt: r.expiresAt, user: r.user } : null;
    setSession(s);
    save(s);
    hub.setToken(s?.token ?? null);
    scheduleRefresh();
  };

  // Short-lived JWTs: refresh a minute before expiry while the tab is open.
  const scheduleRefresh = () => {
    window.clearTimeout(refreshTimer);
    const s = session();
    if (!s) return;
    const ms = new Date(s.expiresAt).getTime() - Date.now() - 60_000;
    refreshTimer = window.setTimeout(() => {
      post<TokenResponse>('/api/auth/refresh').then(apply, () => apply(null));
    }, Math.max(5_000, ms));
  };

  configureClient(
    () => session()?.token ?? null,
    () => apply(null),
  );
  hub.setToken(session()?.token ?? null);
  scheduleRefresh();

  return {
    user: () => session()?.user ?? null,
    isAdmin: () => session()?.user.role === 'ADMIN',
    async login(username: string, password: string) {
      apply(await post<TokenResponse>('/api/auth/login', { username, password }));
    },
    async register(body: { username: string; email: string; password: string; dateOfBirth: string; country: string }) {
      apply(await post<TokenResponse>('/api/auth/register', body));
    },
    async logout() {
      try {
        await post('/api/auth/logout');
      } finally {
        apply(null);
      }
    },
    /** Forget the local session without calling the server (e.g. after self-exclusion revoked it). */
    clear() {
      apply(null);
    },
    async reloadUser() {
      const s = session();
      if (!s) return;
      const user = await get<User>('/api/auth/me');
      const next = { ...s, user };
      setSession(next);
      save(next);
    },
  };
});
