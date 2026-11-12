/**
 * When to ask visitors something: the taste-test invitation, then later a one-tap rating. Visitors who get nothing
 * for answering only answer when asking costs them nothing, so: only while they are actively using the site, never
 * on forms (login, wallet, verification), never two at once or right after another, each at most once per visitor,
 * and always easy to dismiss. Nothing is asked in a tab opened with ?ab= (QA).
 */
import { createEffect, createRoot, createSignal } from 'solid-js';
import { ab } from './experiments';
import { customize, feedbackPanel, tasteTest } from './panels';

export type Prompt = 'invite' | 'pulse';

interface Status {
  /** The invitation was shown (it is never shown twice), or the test was done. */
  invite?: 'shown' | 'done';
  pulse?: 'shown' | 'done';
  /** Rated already (at the end of the taste test or with the Feedback button): no need to ask again. */
  rated?: boolean;
}

const KEY = 'naebka.prompts';
/** Seconds of active use before each prompt, and the gap between two prompts. */
const INVITE_AFTER = 6;
const PULSE_AFTER = 150;
const GAP = 45;

function load(): Status {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Status;
  } catch {
    return {};
  }
}

export const prompts = createRoot(() => {
  const [status, setStatus] = createSignal<Status>(load());
  const [current, setCurrent] = createSignal<Prompt | null>(null);
  const [path, setPath] = createSignal('/');
  // Seconds this visit during which the visitor did something in the last half minute, with the tab visible.
  const [active, setActive] = createSignal(0);
  let lastInput = 0;
  let lastClosed = -Infinity;

  const save = (patch: Status) => {
    const next = { ...status(), ...patch };
    setStatus(next);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // storage blocked: the prompts may come back next visit
    }
  };

  if (typeof window !== 'undefined') {
    for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll']) {
      window.addEventListener(type, () => (lastInput = Date.now()), { capture: true, passive: true });
    }
    window.setInterval(() => {
      if (!document.hidden && Date.now() - lastInput < 30_000) setActive((a) => a + 1);
    }, 1000);
  }

  const quietPage = () => /^\/(admin|login|register|verification|wallet)/.test(path());
  const busy = () => customize.open() || feedbackPanel.open() || tasteTest.open();

  createEffect(() => {
    const seconds = active();
    const s = status();
    if (current() || ab.testing || quietPage() || busy() || seconds - lastClosed < GAP) return;
    if (!s.invite && seconds >= INVITE_AFTER) {
      setCurrent('invite');
      save({ invite: 'shown' });
    } else if (!s.pulse && !s.rated && seconds >= PULSE_AFTER) {
      setCurrent('pulse');
      save({ pulse: 'shown' });
    }
  });

  return {
    current,
    setPath,
    /** Closes the prompt on screen; the next one waits a while. */
    close: () => {
      setCurrent(null);
      lastClosed = active();
    },
    tasteTestDone: () => save({ invite: 'done' }),
    rated: () => save({ rated: true }),
  };
});
