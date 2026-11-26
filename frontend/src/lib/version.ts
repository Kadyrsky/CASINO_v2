/**
 * The version shown under the name in the header (docs/versioning.md). It is built in when the site is built: CI
 * passes the release it is making to core/Dockerfile as NAEBKA_VERSION, which hands it to Vite as
 * VITE_NAEBKA_VERSION, so the live site always says which release it was built from.
 */

/** "1.5.0" (or the tag "v1.5.0") shows as "v1.5.0"; a build nobody gave a number, such as a local one, says "dev". */
export function versionLabel(raw: string | undefined): string {
  const version = (raw ?? '').trim().replace(/^v(?=\d)/, '');
  if (!version) return 'dev';
  return /^\d/.test(version) ? `v${version}` : version;
}

export const appVersion = versionLabel(import.meta.env.VITE_NAEBKA_VERSION);
