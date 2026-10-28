import { Route, Router } from '@solidjs/router';
import { QueryClient, QueryClientProvider } from '@tanstack/solid-query';
import { lazy } from 'solid-js';
import Layout from './components/Layout';
import { RequireAuth } from './components/RequireAuth';
import Lobby from './pages/Lobby';

// Game screens are loaded on demand (Frontend doc: mindful loading of game-specific functionality).
const Login = lazy(() => import('./pages/Login'));
const Register = lazy(() => import('./pages/Register'));
const MatchPage = lazy(() => import('./pages/Match'));
const Bets = lazy(() => import('./pages/Bets'));
const WalletPage = lazy(() => import('./pages/Wallet'));
const Slots = lazy(() => import('./pages/Slots'));
const PokerLobby = lazy(() => import('./pages/PokerLobby'));
const PokerTablePage = lazy(() => import('./pages/PokerTable'));
const Admin = lazy(() => import('./pages/Admin'));
const Verification = lazy(() => import('./pages/Verification'));

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5_000, retry: 1, refetchOnWindowFocus: false } },
});

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Router root={Layout}>
        <Route path="/" component={Lobby} />
        <Route path="/login" component={Login} />
        <Route path="/register" component={Register} />
        <Route path="/matches/:id" component={MatchPage} />
        <Route path="/bets" component={() => <RequireAuth><Bets /></RequireAuth>} />
        <Route path="/wallet" component={() => <RequireAuth><WalletPage /></RequireAuth>} />
        <Route path="/verification" component={() => <RequireAuth><Verification /></RequireAuth>} />
        <Route path="/slots" component={Slots} />
        <Route path="/poker" component={PokerLobby} />
        <Route path="/poker/:id" component={PokerTablePage} />
        <Route path="/admin" component={() => <RequireAuth admin><Admin /></RequireAuth>} />
        <Route path="*" component={() => <p class="py-24 text-center text-ink-400">Page not found.</p>} />
      </Router>
    </QueryClientProvider>
  );
}
