/** Open/closed state of the Customize drop-down and the Feedback panel, so any page or link can open them. */
import { createRoot, createSignal } from 'solid-js';
import { ab } from './experiments';

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
  const [hint, setHint] = createSignal(false);
  const dismissHint = () => {
    setHint(false);
    try {
      localStorage.setItem(HINT_KEY, '1');
    } catch {
      // storage blocked: the hint may show again next visit
    }
  };
  return {
    open,
    hint,
    show: () => {
      dismissHint();
      setOpen(true);
    },
    close: () => setOpen(false),
    toggle: () => {
      dismissHint();
      setOpen(!open());
    },
    /** Shows the first-visit hint, unless it was seen before or versions are forced for testing. */
    maybeHint: () => {
      if (!hintSeen() && !ab.testing) setHint(true);
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
