import { createQuery, useQueryClient } from '@tanstack/solid-query';
import { createSignal, For, Match, Show, Switch } from 'solid-js';
import { ApiError, get, post } from '../api/client';
import type { KycInfo } from '../api/types';
import { KYC_LABEL, KYC_TONE, KycChecks } from '../components/kyc';
import { toast } from '../components/toast';
import { Badge, Button, Card, Field, Input, PageHeader, Select, Spinner } from '../components/ui';
import { countryName, dateTime, humanize, licensedCountries, tokens } from '../lib/format';

/** ICAO 9303 check digit (same rule as the backend): 0-9, A-Z = 10-35, weights 7-3-1, mod 10. */
function checkDigit(body: string): number {
  const weights = [7, 3, 1];
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body.charCodeAt(i);
    const value = c >= 48 && c <= 57 ? c - 48 : c - 55;
    sum += value * weights[i % 3]!;
  }
  return sum % 10;
}

/** A random document number with a valid check digit, so the demo doesn't need a real ID. */
function testDocumentNumber(): string {
  const letters = 'ABCDEFGHJKLMNPRSTUVWXYZ';
  let body = letters.charAt(Math.floor(Math.random() * letters.length));
  for (let i = 0; i < 7; i++) body += Math.floor(Math.random() * 10);
  return body + checkDigit(body);
}

function SubmitForm(props: { onDone: () => void }) {
  const [form, setForm] = createSignal({
    firstName: '', lastName: '', dateOfBirth: '', documentType: 'PASSPORT', documentCountry: 'CZ', documentNumber: '', documentExpiry: '',
  });
  const [errors, setErrors] = createSignal<Record<string, string>>({});
  const [busy, setBusy] = createSignal(false);
  const set = (k: keyof ReturnType<typeof form>) => (e: { currentTarget: { value: string } }) =>
    setForm({ ...form(), [k]: e.currentTarget.value });

  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    try {
      const res = await post<KycInfo>('/api/kyc/submissions', form());
      if (res.status === 'VERIFIED') toast.success('Identity verified. Withdrawals are unlocked.');
      else if (res.status === 'PENDING') toast.info('Submitted. An admin will review your details.');
      else toast.error(res.latest?.reason ?? 'Verification was rejected');
      props.onDone();
    } catch (err) {
      if (err instanceof ApiError && err.extra.fields) setErrors(err.extra.fields as Record<string, string>);
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form class="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2" onSubmit={submit}>
      <Field label="First name" error={errors().firstName}>
        <Input required autocomplete="given-name" value={form().firstName} onInput={set('firstName')} />
      </Field>
      <Field label="Last name" error={errors().lastName}>
        <Input required autocomplete="family-name" value={form().lastName} onInput={set('lastName')} />
      </Field>
      <Field label="Date of birth" error={errors().dateOfBirth} hint="As printed on the document">
        <Input type="date" required value={form().dateOfBirth} onInput={set('dateOfBirth')} />
      </Field>
      <Field label="Document type">
        <Select value={form().documentType} onChange={set('documentType')}>
          <option value="PASSPORT">Passport</option>
          <option value="ID_CARD">National ID card</option>
          <option value="DRIVING_LICENCE">Driving licence</option>
        </Select>
      </Field>
      <Field label="Issuing country">
        <Select value={form().documentCountry} onChange={set('documentCountry')}>
          <For each={licensedCountries()}>
            {(c) => <option value={c} selected={c === form().documentCountry}>{countryName(c)}</option>}
          </For>
        </Select>
      </Field>
      <Field label="Expiry date" error={errors().documentExpiry}>
        <Input type="date" required value={form().documentExpiry} onInput={set('documentExpiry')} />
      </Field>
      <Field
        label="Document number"
        error={errors().documentNumber}
        class="sm:col-span-2"
        hint={
          <>
            Include the check digit from the machine-readable line as the last character.{' '}
            <button type="button" class="font-semibold text-gold-300 hover:underline" onClick={() => setForm({ ...form(), documentNumber: testDocumentNumber() })}>
              Use a test number
            </button>
          </>
        }
      >
        <Input required minLength={6} maxLength={20} value={form().documentNumber} onInput={set('documentNumber')} class="font-mono uppercase" />
      </Field>
      <p class="text-xs text-ink-400 sm:col-span-2">
        Play-money demo: don't enter a real document. We store only the last 4 characters of the number and a one-way hash.
      </p>
      <Button type="submit" size="lg" class="sm:col-span-2" loading={busy()}>Verify my identity</Button>
    </form>
  );
}

export default function Verification() {
  const queryClient = useQueryClient();
  const kyc = createQuery(() => ({ queryKey: ['kyc'], queryFn: () => get<KycInfo>('/api/kyc') }));
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['kyc'] });
  return (
    <div class="mx-auto max-w-3xl">
      <PageHeader title="Identity verification" subtitle="Verify once to unlock withdrawals and remove the deposit cap." />
      <Show when={kyc.data} fallback={<div class="grid place-items-center py-24"><Spinner /></div>}>
        {(info) => (
          <div class="flex flex-col gap-6">
            <Card class="p-5">
              <div class="flex flex-wrap items-center justify-between gap-3">
                <div class="flex items-center gap-3">
                  <Badge tone={KYC_TONE[info().status]}>{KYC_LABEL[info().status]}</Badge>
                  <span class="text-sm text-ink-400">
                    <Switch>
                      <Match when={info().status === 'VERIFIED'}>No limits from verification apply to your account.</Match>
                      <Match when={info().status === 'PENDING'}>Some details need a human look. This usually takes less than a day.</Match>
                      <Match when={info().status === 'REJECTED'}>Fix the issue below and submit again.</Match>
                      <Match when={true}>You can play, but cannot withdraw until you are verified.</Match>
                    </Switch>
                  </span>
                </div>
                <Show when={info().depositCapTokens}>
                  <span class="tabular text-sm text-ink-300">
                    Deposits {tokens(info().depositedTokens)} / {tokens(info().depositCapTokens)} NTK
                  </span>
                </Show>
              </div>
              <Show when={info().latest}>
                {(s) => (
                  <div class="mt-4 border-t border-ink-700/60 pt-4">
                    <p class="mb-3 text-xs text-ink-400">
                      Last submission {dateTime(s().createdAt)} · {humanize(s().documentType)} ···{s().documentNumberLast4}
                      <Show when={s().decidedBy}> · decided {s().decidedBy === 'AUTO' ? 'automatically' : 'by an admin'}</Show>
                    </p>
                    <Show when={s().reason}>
                      <p class="mb-3 rounded-lg bg-ink-850 px-3 py-2 text-sm text-ink-200">{s().reason}</p>
                    </Show>
                    <KycChecks checks={s().checks} />
                  </div>
                )}
              </Show>
            </Card>
            <Show when={info().status === 'NONE' || info().status === 'REJECTED'}>
              <Card title="Your details">
                <SubmitForm onDone={refresh} />
              </Card>
            </Show>
          </div>
        )}
      </Show>
    </div>
  );
}
