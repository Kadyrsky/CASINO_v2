/**
 * The taste test: "which do you like more?", two versions side by side for each experiment that is a matter of
 * taste (theme, music, sound effects, slot symbols). The visitor tries both (the page switches to it, or they listen
 * to it), picks one and keeps it, so answering is its own reward. Each answer is a head-to-head comparison by the
 * same person, which says far more per visitor than splitting a hundred people into groups; the dashboard ranks
 * the versions from all answers (docs/ab-testing.md).
 *
 * The music is asked about at two levels: after "which music?", a pack with several versions (the hideout loop's
 * tempos, the hotel's record near or far...) gets a follow-up, "which version of it?", for the pack just picked.
 *
 * Pairs are drawn at random among the candidates (not pickOnly) and sides are shuffled, so neither the pair nor
 * the side favours a version. Every answer is sent straight away, so stopping halfway still counts.
 */
import { createSignal, For, onCleanup, Show } from 'solid-js';
import { ab, EXPERIMENTS, experiment, variantLabel, type Experiment } from '../lib/experiments';
import { packAvailable, versionAvailable } from '../lib/musicCatalog';
import { packOfExperiment, versionExperiment } from '../lib/musicPacks';
import { customize, tasteTest } from '../lib/panels';
import { prompts } from '../lib/prompts';
import { previewKey, sounds } from '../lib/sounds';
import { QuickRating } from './QuickRating';
import { artOf } from './variantArt';

interface Round {
  key: string;
  left: string;
  right: string;
  started: number;
}

const PAIRS_KEY = 'naebka.taste.pairs';

function answered(): string[] {
  try {
    return JSON.parse(localStorage.getItem(PAIRS_KEY) ?? '[]') as string[];
  } catch {
    return [];
  }
}

function remember(pair: string) {
  try {
    localStorage.setItem(PAIRS_KEY, JSON.stringify([...answered(), pair]));
  } catch {
    // storage blocked: the same pair may come up again
  }
}

const pairId = (key: string, a: string, b: string) => `${key}:${[a, b].sort().join('|')}`;

function candidates(e: Experiment): string[] {
  const ids = e.variants.filter((v) => !v.pickOnly).map((v) => v.id);
  if (e.key === 'music_pack') return ids.filter(packAvailable);
  const pack = packOfExperiment(e.key);
  return pack ? ids.filter((id) => versionAvailable(pack, id)) : ids;
}

/** A random pair of this experiment the visitor hasn't answered yet, on random sides. */
function roundFor(e: Experiment): Round | null {
  const ids = candidates(e);
  const done = answered();
  const open: [string, string][] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) if (!done.includes(pairId(e.key, ids[i]!, ids[j]!))) open.push([ids[i]!, ids[j]!]);
  }
  if (!open.length) return null;
  const [a, b] = open[Math.floor(Math.random() * open.length)]!;
  const [left, right] = Math.random() < 0.5 ? [a, b] : [b, a];
  return { key: e.key, left, right, started: Date.now() };
}

/** The follow-up "which version?" for a music pack, if it has versions with a pair still to ask. */
function versionRound(pack: string): Round | null {
  const key = versionExperiment(pack);
  return key ? roundFor(experiment(key)) : null;
}

/**
 * One round per taste experiment that still has a pair to ask. The music packs' versions are asked as a follow-up
 * to the music question (see answer()), or on their own for the visitor's pack once the packs are all compared.
 */
function plan(): Round[] {
  return EXPERIMENTS.filter((e) => e.taste && !e.parent).flatMap((e) => {
    const r = roundFor(e);
    if (e.key !== 'music_pack') return r ?? [];
    if (r) return r;
    return versionRound(ab.committed('music_pack')) ?? [];
  });
}

export const tasteTestAvailable = () => plan().length > 0;

function Tile(props: { round: Round; id: string; tried: boolean; onTry: () => void; onPick: () => void; canPick: boolean }) {
  const exp = () => experiment(props.round.key);
  const art = () => artOf(props.round.key, props.id);
  const playing = () => sounds.previewing() === previewKey(props.round.key, props.id);
  const showing = () => exp().taste?.tryBy === 'page' && ab.variant(props.round.key) === props.id;
  const action = () => {
    const by = exp().taste?.tryBy;
    if (by === 'look') return null;
    if (playing()) return '♪ Playing…';
    if (showing()) return '● On the page now';
    if (props.tried) return by === 'listen' ? '↻ Play again' : '✓ Seen';
    return by === 'listen' ? '▶ Listen' : '◐ Show on page';
  };
  return (
    <div class="flex flex-1 flex-col gap-2">
      <button
        data-sound="none"
        onClick={props.onTry}
        class={`flex flex-1 flex-col items-center gap-2 rounded-xl bg-ink-850 p-2.5 text-center transition-all ${
          showing() || playing() ? `ring-2 ${art()?.ring ?? 'ring-gold-400'}` : 'ring-1 ring-ink-700 hover:ring-ink-500'
        }`}
        aria-label={`Try ${variantLabel(props.round.key, props.id)}`}
      >
        <span class={`grid h-14 w-full place-items-center rounded-lg ${art()?.bg ?? 'bg-ink-800'}`}>{art()?.art()}</span>
        <span class="leading-tight">
          <span class="block text-sm font-semibold text-ink-100">{variantLabel(props.round.key, props.id)}</span>
          <Show when={art()?.note}>
            <span class="block text-[11px] text-ink-400">{art()!.note}</span>
          </Show>
        </span>
        <Show when={action()}>
          <span class={`text-[11px] font-semibold ${playing() || showing() ? 'text-gold-300' : 'text-ink-300'}`}>{action()}</span>
        </Show>
      </button>
      <button
        data-sound="none"
        onClick={props.onPick}
        disabled={!props.canPick}
        class="btn-dl dl-type h-9 rounded-lg bg-gold-500 text-sm font-semibold text-ink-950 hover:bg-gold-400 disabled:cursor-not-allowed disabled:opacity-35"
      >
        I like this one
      </button>
    </div>
  );
}

/** A theme the visitor is already looking at counts as tried: they only need to look at the other one. */
function seenAlready(r: Round | undefined): string[] {
  if (!r || experiment(r.key).taste?.tryBy !== 'page') return [];
  const now = ab.committed(r.key);
  return now === r.left || now === r.right ? [now] : [];
}

function Test() {
  const [rounds, setRounds] = createSignal<Round[]>(plan());
  const [index, setIndex] = createSignal(0);
  const [tried, setTried] = createSignal<string[]>(seenAlready(rounds()[0]));
  const [picks, setPicks] = createSignal<Record<string, string>>({});
  const round = () => rounds()[index()];
  const exp = () => (round() ? experiment(round()!.key) : null);
  const bothTried = () => !!round() && tried().includes(round()!.left) && tried().includes(round()!.right);
  const canPick = () => exp()?.taste?.tryBy === 'look' || bothTried();

  const endPreview = () => {
    const r = round();
    if (r) ab.preview(r.key, null);
    sounds.stopPreview();
  };
  onCleanup(endPreview);

  const tryIt = (id: string) => {
    const r = round();
    if (!r) return;
    const by = experiment(r.key).taste?.tryBy;
    const pack = packOfExperiment(r.key);
    if (r.key === 'music_pack') sounds.previewPack(id);
    else if (pack) sounds.previewVersion(pack, id);
    else if (r.key === 'sfx_pack') sounds.previewSounds(id);
    else {
      ab.preview(r.key, id);
      sounds.play('select');
    }
    if (by !== 'look' && !tried().includes(id)) setTried([...tried(), id]);
  };

  const answer = (winner: string | null) => {
    const r = round();
    if (!r) return;
    ab.vote({
      experiment: r.key,
      left: r.left,
      right: r.right,
      winner,
      previewedBoth: exp()?.taste?.tryBy === 'look' || bothTried(),
      decisionMs: Date.now() - r.started,
    });
    remember(pairId(r.key, r.left, r.right));
    endPreview();
    if (winner) {
      ab.choose(r.key, winner, 'taste_test');
      setPicks({ ...picks(), [r.key]: winner });
      if (r.key === 'theme') sounds.theme(winner);
      else sounds.play('select');
    }
    // After the music: which version of the pack just picked (or the one they're on), if it has versions to compare.
    if (r.key === 'music_pack') {
      const follow = versionRound(winner ?? ab.committed('music_pack'));
      if (follow && !rounds().some((x) => x.key === follow.key)) setRounds([...rounds().slice(0, index() + 1), follow, ...rounds().slice(index() + 1)]);
    }
    const next = index() + 1;
    if (next < rounds().length) {
      setRounds(rounds().map((x, i) => (i === next ? { ...x, started: Date.now() } : x)));
      setTried(seenAlready(rounds()[next]));
    } else {
      setTried([]);
      prompts.tasteTestDone();
    }
    setIndex(next);
  };

  const more = () => {
    const next = plan();
    setRounds(next);
    setIndex(0);
    setTried(seenAlready(next[0]));
  };

  const close = () => {
    endPreview();
    tasteTest.close();
  };

  return (
    <section
      aria-label="Taste test"
      class="fixed inset-x-2 bottom-2 z-50 flex max-h-[80vh] animate-pop flex-col overflow-y-auto rounded-2xl border border-ink-600 bg-ink-900/97 shadow-2xl backdrop-blur sm:inset-x-auto sm:bottom-4 sm:left-4 sm:w-[24rem]"
    >
      <header class="flex items-center justify-between gap-2 border-b border-ink-700 px-4 py-2.5">
        <div class="flex items-center gap-2">
          <h3 class="text-sm font-semibold">Pick your Naebka</h3>
          <Show when={round()}>
            <span class="flex gap-1" aria-label={`Question ${index() + 1} of ${rounds().length}`}>
              <For each={rounds()}>
                {(_, i) => <span class={`size-1.5 rounded-full ${i() < index() ? 'bg-gold-500' : i() === index() ? 'bg-gold-300' : 'bg-ink-600'}`} />}
              </For>
            </span>
          </Show>
        </div>
        <button class="grid size-7 place-items-center rounded-md text-ink-400 hover:bg-ink-800 hover:text-ink-100" onClick={close} aria-label="Close" title="Close">
          ✕
        </button>
      </header>
      <div class="px-4 py-3">
        <Show
          when={round()}
          fallback={
            <div class="flex flex-col gap-3">
              <Show
                when={Object.keys(picks()).length}
                fallback={<p class="text-sm text-ink-300">You’ve compared everything there is — thank you!</p>}
              >
                <p class="text-sm text-ink-200">
                  <span class="font-semibold text-ink-100">Saved!</span> You’re now on{' '}
                  {Object.entries(picks())
                    .map(([k, v]) => variantLabel(k, v))
                    .join(' · ')}
                  . Change anything later under Customize.
                </p>
              </Show>
              <div class="rounded-xl bg-ink-850 p-3 ring-1 ring-ink-700">
                <QuickRating source="taste_test" question="And overall, how’s Naebka so far?" onDone={() => {}} />
              </div>
              <div class="flex justify-end gap-2">
                <Show when={tasteTestAvailable()}>
                  <button class="rounded-lg px-3 py-1.5 text-xs font-semibold text-ink-300 ring-1 ring-ink-700 hover:bg-ink-800" onClick={more}>
                    Compare more
                  </button>
                </Show>
                <button class="btn-dl dl-type rounded-lg bg-gold-500 px-3 py-1.5 text-xs font-semibold text-ink-950 hover:bg-gold-400" onClick={close}>
                  Done
                </button>
              </div>
            </div>
          }
        >
          {(r) => (
            <div class="flex flex-col gap-3">
              <div>
                <p class="text-base font-semibold text-ink-100">{exp()?.taste?.question}</p>
                <p class="text-xs text-ink-400">
                  {exp()?.taste?.tryBy === 'look'
                    ? 'Tap the one you like.'
                    : exp()?.taste?.tryBy === 'listen'
                      ? 'Listen to both, then pick.'
                      : 'Tap each to see it on the page, then pick.'}
                </p>
              </div>
              <div class="flex gap-2.5">
                <For each={[r().left, r().right]}>
                  {(id) => <Tile round={r()} id={id} tried={tried().includes(id)} onTry={() => tryIt(id)} onPick={() => answer(id)} canPick={canPick()} />}
                </For>
              </div>
              <div class="flex items-center justify-between text-xs">
                <span class="text-ink-500">{canPick() ? 'Your pick is applied straight away.' : 'Try both to choose.'}</span>
                <button class="font-semibold text-ink-400 hover:text-ink-200" onClick={() => answer(null)}>
                  No preference
                </button>
              </div>
            </div>
          )}
        </Show>
      </div>
    </section>
  );
}

/** The first-visit invitation (see prompts.ts). */
function Invite() {
  return (
    <section
      aria-label="Pick your Naebka"
      class="fixed inset-x-2 bottom-2 z-40 animate-pop rounded-2xl border border-gold-500/50 bg-ink-900/97 p-4 shadow-2xl backdrop-blur sm:inset-x-auto sm:bottom-4 sm:left-4 sm:w-[22rem]"
    >
      <p class="text-sm font-semibold text-ink-100">Make Naebka yours</p>
      <p class="mt-1 text-xs text-ink-300">
        Choose the look, music and sounds you like: a few quick “this or that” picks, about half a minute. Your answers also help us
        pick what everyone gets.
      </p>
      <div class="mt-3 flex justify-end gap-2">
        <button
          class="rounded-lg px-3 py-1.5 text-xs font-semibold text-ink-300 hover:bg-ink-800"
          onClick={() => {
            prompts.close();
            customize.dismissHint();
          }}
        >
          Not now
        </button>
        <button
          class="btn-dl dl-type rounded-lg bg-gold-500 px-3 py-1.5 text-xs font-semibold text-ink-950 hover:bg-gold-400"
          onClick={() => {
            prompts.close();
            tasteTest.show();
          }}
        >
          Let’s go
        </button>
      </div>
    </section>
  );
}

/** Bottom-left: the taste test when open, otherwise the invitation if it is due. */
export function TasteTestDock() {
  return (
    <Show when={tasteTest.open()} fallback={<Show when={prompts.current() === 'invite'}><Invite /></Show>}>
      <Test />
    </Show>
  );
}
