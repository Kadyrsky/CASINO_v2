import { A, useNavigate } from '@solidjs/router';
import { createSignal, For, Show } from 'solid-js';
import { ApiError } from '../api/client';
import { Button, Card, Field, Input, Select } from '../components/ui';
import { auth } from '../lib/auth';
import { appConfig } from '../lib/format';

const countryNames = new Intl.DisplayNames(['en'], { type: 'region' });

export default function Register() {
  const navigate = useNavigate();
  const [form, setForm] = createSignal({ username: '', email: '', password: '', dateOfBirth: '', country: 'CZ' });
  const [errors, setErrors] = createSignal<Record<string, string>>({});
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [confirmed, setConfirmed] = createSignal(false);

  const set = (k: keyof ReturnType<typeof form>) => (e: { currentTarget: { value: string } }) =>
    setForm({ ...form(), [k]: e.currentTarget.value });

  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setErrors({});
    try {
      await auth.register(form());
      navigate('/', { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.extra.fields) setErrors(err.extra.fields as Record<string, string>);
      setError(err instanceof ApiError ? err.message : 'Registration failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="mx-auto mt-6 max-w-md sm:mt-12">
      <h1 class="mb-1 text-3xl font-extrabold tracking-tight">Create your account</h1>
      <p class="mb-6 text-sm text-ink-400">You get 1,000 play-money tokens to start. Must be 18+ and in a licensed country.</p>
      <Card class="p-5">
        <form class="grid grid-cols-1 gap-4 sm:grid-cols-2" onSubmit={submit}>
          <Field label="Username" error={errors().username} class="sm:col-span-2" hint="3–24 letters, numbers, . _ -">
            <Input required autocomplete="username" value={form().username} onInput={set('username')} invalid={!!errors().username} />
          </Field>
          <Field label="Email" error={errors().email} class="sm:col-span-2">
            <Input type="email" required autocomplete="email" value={form().email} onInput={set('email')} invalid={!!errors().email} />
          </Field>
          <Field label="Password" error={errors().password} class="sm:col-span-2" hint="At least 8 characters">
            <Input type="password" required minLength={8} autocomplete="new-password" value={form().password} onInput={set('password')} invalid={!!errors().password} />
          </Field>
          <Field label="Date of birth" error={errors().dateOfBirth}>
            <Input type="date" required value={form().dateOfBirth} onInput={set('dateOfBirth')} />
          </Field>
          <Field label="Country">
            <Select value={form().country} onChange={set('country')}>
              <For each={appConfig()?.licensedCountries ?? ['CZ']}>
                {(c) => <option value={c}>{countryNames.of(c) ?? c}</option>}
              </For>
            </Select>
          </Field>
          <label class="flex items-start gap-2 text-sm text-ink-300 sm:col-span-2">
            <input type="checkbox" class="mt-0.5 accent-gold-500" checked={confirmed()} onChange={(e) => setConfirmed(e.currentTarget.checked)} />
            I am at least 18 years old and accept that gambling can be addictive.
          </label>
          <Show when={error()}>
            <p role="alert" class="rounded-lg bg-loss/10 px-3 py-2 text-sm text-loss sm:col-span-2">{error()}</p>
          </Show>
          <Button type="submit" size="lg" class="sm:col-span-2" loading={busy()} disabled={!confirmed()}>
            Create account
          </Button>
        </form>
      </Card>
      <p class="mt-4 text-center text-sm text-ink-400">
        Already registered? <A href="/login" class="font-semibold text-gold-300 hover:underline">Log in</A>
      </p>
    </div>
  );
}
