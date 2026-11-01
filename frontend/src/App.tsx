import { Navigate, Route, Router } from '@solidjs/router';
import { QueryClient, QueryClientProvider } from '@tanstack/solid-query';
import { lazy } from 'solid-js';
import Layout from './components/Layout';
import { RequireAuth } from './components/RequireAuth';

// Game screens are loaded on demand (Frontend doc: mindful loading of game-specific functionality).
const Login = lazy(() => import('./pages/Login'));
const Register = lazy(() => import('./pages/Register'));
const WalletPage = lazy(() => import('./pages/Wallet'));

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5_000, retry: 1, refetchOnWindowFocus: false } },
});

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Router root={Layout}>
        <Route path="/" component={() => <Navigate href="/wallet" />} />
        <Route path="/login" component={Login} />
        <Route path="/register" component={Register} />
        <Route path="/wallet" component={() => <RequireAuth><WalletPage /></RequireAuth>} />
        <Route path="*" component={() => <p class="py-24 text-center text-ink-400">Page not found.</p>} />
      </Router>
    </QueryClientProvider>
  );
}
