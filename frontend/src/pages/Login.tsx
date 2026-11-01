import { A, useNavigate, useSearchParams } from '@solidjs/router';
import { createSignal, Show } from 'solid-js';
import { ApiError } from '../api/client';
import { Button, Card, Field, Input } from '../components/ui';
import { auth } from '../lib/auth';

export default function Login() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [username, setUsername] = createSignal('');
  const [password, setPassword] = createSignal('');
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);

  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await auth.login(username(), password());
      const next = typeof params.next === 'string' && params.next.startsWith('/') ? params.next : '/';
      navigate(next, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Login failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="mx-auto mt-6 max-w-sm sm:mt-16">
      <h1 class="mb-1 text-3xl font-extrabold tracking-tight">Welcome back</h1>
      <p class="mb-6 text-sm text-ink-400">Log in to bet on live Deadlock matches, spin and play poker.</p>
      <Card class="p-5">
        <form class="flex flex-col gap-4" onSubmit={submit}>
          <Field label="Username">
            <Input autocomplete="username" required value={username()} onInput={(e) => setUsername(e.currentTarget.value)} />
          </Field>
          <Field label="Password">
            <Input type="password" autocomplete="current-password" required value={password()} onInput={(e) => setPassword(e.currentTarget.value)} />
          </Field>
          <Show when={error()}>
            <p role="alert" class="rounded-lg bg-loss/10 px-3 py-2 text-sm text-loss">{error()}</p>
          </Show>
          <Button type="submit" size="lg" loading={busy()}>Log in</Button>
          <Button type="button" variant="ghost" disabled title="Steam OpenID is planned for a later iteration">
            Sign in through Steam (soon)
          </Button>
        </form>
      </Card>
      <p class="mt-4 text-center text-sm text-ink-400">
        New here? <A href="/register" class="font-semibold text-gold-300 hover:underline">Create an account</A>
      </p>
    </div>
  );
}
