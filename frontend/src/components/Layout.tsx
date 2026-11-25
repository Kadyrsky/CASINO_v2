import { A, useLocation, useNavigate, type RouteSectionProps } from '@solidjs/router';
import { createEffect, createSignal, For, onMount, Show } from 'solid-js';
import { auth } from '../lib/auth';
import { eth, shortAddress } from '../lib/eth';
import { ab } from '../lib/experiments';
import { appConfig, fiat, tokens } from '../lib/format';
import { wallet } from '../lib/wallet';
import { hub } from '../lib/ws';
import { customize, feedbackPanel, tasteTest } from '../lib/panels';
import { prompts } from '../lib/prompts';
import { appVersion } from '../lib/version';
import { CustomizeButton } from './Appearance';
import { Disclaimer } from './Disclaimer';
import { FeedbackDock } from './Feedback';
import { PulseCard } from './QuickRating';
import { SoundButton } from './SoundControls';
import { TasteTestDock } from './TasteTest';
import { Toaster } from './toast';

const nav = [
  { href: '/', label: 'Live', icon: '◉', end: true },
  { href: '/slots', label: 'Slots', icon: '❖' },
  { href: '/poker', label: 'Poker', icon: '♠' },
  { href: '/bets', label: 'My bets', icon: '☰', auth: true },
  { href: '/wallet', label: 'Wallet', icon: '◈', auth: true },
];

export default function Layout(props: RouteSectionProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = createSignal(false);
  const openCustomize = () => {
    setMenuOpen(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
    customize.show();
  };

  // A/B: the theme is on every page; the sign-up button only shows to logged-out visitors.
  onMount(() => ab.expose('theme'));
  createEffect(() => {
    if (!auth.user()) ab.expose('join_cta');
  });
  // Prompts stay away from forms (prompts.ts).
  createEffect(() => prompts.setPath(location.pathname));

  const logout = async () => {
    setMenuOpen(false);
    await auth.logout();
    navigate('/login');
  };

  return (
    <div class="flex min-h-screen flex-col">
      {/* The theme's Patron drifting in the background (styles.css; only in the Patron themes). */}
      <div class="patron-bg" aria-hidden="true" />
      <header class="sticky top-0 z-40 border-b border-ink-800 bg-ink-950/85 backdrop-blur-md">
        <div class="mx-auto flex h-16 max-w-7xl items-center gap-4 px-4">
          <A href="/" class="flex items-center gap-2" aria-label="Naebka home">
            <span class="grid size-8 place-items-center rounded-lg bg-gradient-to-br from-gold-300 to-gold-600 text-sm font-black text-ink-950 shadow-[0_0_20px_-4px_color-mix(in_oklab,var(--color-gold-500)_70%,transparent)]">
              N
            </span>
            {/* The name and, under it, the version this build is (lib/version.ts). */}
            <span class="hidden flex-col sm:flex">
              <span class="dl-type text-lg font-extrabold leading-tight tracking-tight">naebka</span>
              <span class="tabular text-[11px] leading-tight text-ink-400">{appVersion}</span>
            </span>
          </A>

          <nav class="no-scrollbar -mx-1 flex flex-1 gap-1 overflow-x-auto px-1">
            <For each={nav.filter((n) => !n.auth || auth.user())}>
              {(n) => (
                <A
                  href={n.href}
                  end={n.end}
                  class="dl-type flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-ink-400 transition-colors hover:bg-ink-850 hover:text-ink-100"
                  activeClass="!bg-ink-800 !text-ink-100"
                >
                  <span class="text-xs opacity-70">{n.icon}</span>
                  {n.label}
                </A>
              )}
            </For>
            <Show when={auth.isAdmin()}>
              <A href="/admin" class="shrink-0 rounded-lg px-3 py-2 text-sm font-medium text-warn hover:bg-ink-850" activeClass="!bg-ink-800">
                Admin
              </A>
            </Show>
          </nav>

          <div class="flex shrink-0 items-center gap-2">
            <SoundButton />
            <CustomizeButton />
          </div>

          <Show
            when={auth.user()}
            fallback={
              <div class="flex shrink-0 gap-2">
                <A href="/login" class="dl-type rounded-lg px-3 py-2 text-sm font-semibold text-ink-200 hover:bg-ink-850">
                  Log in
                </A>
                <A href="/register" class="btn-dl dl-type rounded-lg bg-gold-500 px-3 py-2 text-sm font-semibold text-ink-950 hover:bg-gold-400">
                  <Show when={ab.variant('join_cta') === 'bonus'} fallback="Join">
                    <span class="sm:hidden">1,000 free NTK</span>
                    <span class="hidden sm:inline">Get 1,000 free NTK</span>
                  </Show>
                </A>
              </div>
            }
          >
            {(user) => (
              <div class="relative flex shrink-0 items-center gap-2">
                <Show when={eth.account()}>
                  {(a) => (
                    <A
                      href="/wallet#sepolia"
                      title={`MetaMask: ${a()} on Sepolia`}
                      class="tabular hidden items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-ink-300 ring-1 ring-ink-700 hover:bg-ink-850 md:flex"
                    >
                      <span class="size-1.5 rounded-full bg-win" />
                      {shortAddress(a())}
                    </A>
                  )}
                </Show>
                <A
                  href="/wallet"
                  class={`tabular hidden flex-col items-end rounded-lg px-3 py-1 leading-tight ring-1 ring-ink-700 transition-colors sm:flex ${wallet.flash() === 'up' ? 'animate-flash-up' : wallet.flash() === 'down' ? 'animate-flash-down' : ''}`}
                >
                  <span class="text-sm font-bold text-gold-300">{wallet.balance() == null ? '…' : tokens(wallet.balance())} NTK</span>
                  <span class="text-[11px] text-ink-400">≈ {fiat(wallet.balance())}</span>
                </A>
                <button
                  class="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-ink-850"
                  onClick={() => setMenuOpen(!menuOpen())}
                  aria-haspopup="menu"
                  aria-expanded={menuOpen()}
                >
                  <span class="grid size-7 place-items-center rounded-full bg-ink-700 text-xs font-bold uppercase">
                    {user().username.slice(0, 2)}
                  </span>
                </button>
                <Show when={menuOpen()}>
                  <div role="menu" class="absolute right-0 top-11 w-52 animate-pop rounded-xl border border-ink-700 bg-ink-900 p-1 shadow-xl">
                    <div class="px-3 py-2 text-xs text-ink-400">
                      Signed in as <span class="font-semibold text-ink-200">{user().username}</span>
                    </div>
                    <A href="/wallet" class="block rounded-lg px-3 py-2 text-sm hover:bg-ink-800" onClick={() => setMenuOpen(false)}>
                      Wallet & limits
                    </A>
                    <A href="/verification" class="block rounded-lg px-3 py-2 text-sm hover:bg-ink-800" onClick={() => setMenuOpen(false)}>
                      Profile & verification
                    </A>
                    <A href="/bets" class="block rounded-lg px-3 py-2 text-sm hover:bg-ink-800" onClick={() => setMenuOpen(false)}>
                      My bets
                    </A>
                    <button class="block w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-ink-800" onClick={openCustomize}>
                      Customize look & sound
                    </button>
                    <button class="block w-full rounded-lg px-3 py-2 text-left text-sm text-loss hover:bg-ink-800" onClick={logout}>
                      Log out
                    </button>
                  </div>
                </Show>
              </div>
            )}
          </Show>
        </div>
      </header>

      <Show when={hub.status() === 'closed'}>
        <div class="bg-warn/10 py-1.5 text-center text-xs font-medium text-warn">Live connection lost — reconnecting…</div>
      </Show>

      <main class="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:py-8">{props.children}</main>

      {/* Responsible-gambling information is reachable from every page (Risk #4). */}
      <footer class="border-t border-ink-800 bg-ink-950/70">
        <div class="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 pb-20 pt-4 text-xs text-ink-400">
          <div class="flex items-center gap-3">
            <span class="grid size-7 place-items-center rounded-full border-2 border-loss text-[10px] font-black text-loss">18+</span>
            <span>
              Gamble responsibly.{' '}
              <Show when={appConfig()?.currencyMode === 'PLAY_MONEY'}>
                <span class="font-semibold text-gold-300">Play-money mode</span> — tokens have no cash value.
              </Show>
            </span>
          </div>
          <div class="flex flex-wrap gap-4">
            <button class="hover:text-ink-200" onClick={openCustomize}>Customize</button>
            <button class="hover:text-ink-200" onClick={() => tasteTest.show()}>Pick your style</button>
            <button class="hover:text-ink-200" onClick={feedbackPanel.show}>Feedback</button>
            <A href="/wallet#limits" class="hover:text-ink-200">Set limits</A>
            <A href="/wallet#self-exclusion" class="hover:text-ink-200">Self-exclusion</A>
            <a href="https://www.begambleaware.org" target="_blank" rel="noreferrer" class="hover:text-ink-200">Get help</a>
          </div>
        </div>
      </footer>
      <FeedbackDock />
      {/* Bottom left: the taste test or its invitation, or later the one-tap rating (one at a time, see prompts.ts). */}
      <TasteTestDock />
      <Show when={prompts.current() === 'pulse' && !tasteTest.open()}>
        <PulseCard />
      </Show>
      <Toaster />
      <Disclaimer />
    </div>
  );
}
