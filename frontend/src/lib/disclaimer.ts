/**
 * The notice that Naebka is a course project with play money, not a real casino. Visitors who aren't logged in see it
 * every time they open the site (once per visit, so not again on each page change); logged-in players never do.
 */
import { createRoot, createSignal } from 'solid-js';
import { auth } from './auth';
import { needsDisclaimer } from './disclaimerRule';
import { ab } from './experiments';
import { appConfig } from './format';

/** sessionStorage: kept while the tab is open, gone when the site is opened again. */
const KEY = 'naebka.disclaimer';

function acceptedThisVisit(): boolean {
  try {
    return sessionStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export const disclaimer = createRoot(() => {
  const [accepted, setAccepted] = createSignal(acceptedThisVisit());
  return {
    /** On screen now. Waits for the config so it never claims "play money" on a real-money deployment; QA tabs
     *  (?ab=) skip it. */
    open: () =>
      needsDisclaimer(auth.user() !== null, accepted()) && !ab.testing && appConfig()?.currencyMode === 'PLAY_MONEY',
    accept: () => {
      setAccepted(true);
      try {
        sessionStorage.setItem(KEY, '1');
      } catch {
        // storage blocked: the notice comes back on the next page load
      }
    },
  };
});
