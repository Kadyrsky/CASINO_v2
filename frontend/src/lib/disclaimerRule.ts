/** When the play-money notice shows (disclaimer.ts); plain logic, so it is unit-tested without a browser. */

/** Shown to visitors who aren't logged in and haven't accepted it during this visit. */
export function needsDisclaimer(loggedIn: boolean, acceptedThisVisit: boolean): boolean {
  return !loggedIn && !acceptedThisVisit;
}
