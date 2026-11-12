/** Open/closed state of the Customize drop-down, the Feedback panel and the taste test, so any page can open them. */
import { createRoot, createSignal } from 'solid-js';

const HINT_KEY = 'naebka.ab.hintSeen';

function hintSeen(): boolean {
  try {
    return localStorage.getItem(HINT_KEY) === '1';
  } catch {
    return true;
  }
}

export const customize = createRoot(() => {
  const [open, setOpen] = createSignal(false);
  // A dot on the Customize button until it has been opened once.
  const [hint, setHint] = createSignal(!hintSeen());
  const [tab, setTab] = createSignal<'look' | 'sound'>('look');
  const dismissHint = () => {
    setHint(false);
    try {
      localStorage.setItem(HINT_KEY, '1');
    } catch {
      // storage blocked: the dot may show again next visit
    }
  };
  return {
    open,
    hint,
    tab,
    setTab,
    show: (on: 'look' | 'sound' = tab()) => {
      dismissHint();
      setTab(on);
      setOpen(true);
    },
    close: () => setOpen(false),
    toggle: () => {
      dismissHint();
      setOpen(!open());
    },
    dismissHint,
  };
});

export const feedbackPanel = createRoot(() => {
  const [open, setOpen] = createSignal(false);
  const [minimized, setMinimized] = createSignal(false);
  return {
    open,
    minimized,
    show: () => {
      setOpen(true);
      setMinimized(false);
    },
    close: () => setOpen(false),
    setMinimized,
  };
});

/** The taste test ("which do you like more?"), see TasteTest.tsx. */
export const tasteTest = createRoot(() => {
  const [open, setOpen] = createSignal(false);
  return {
    open,
    show: () => {
      customize.close();
      setOpen(true);
    },
    close: () => setOpen(false),
  };
});
