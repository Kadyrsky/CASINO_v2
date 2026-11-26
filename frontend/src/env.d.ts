// Values Vite builds into the code from the environment, on top of vite/client's own (tsconfig "types").
interface ImportMetaEnv {
  /** The release being built, e.g. "1.5.0" (lib/version.ts, docs/versioning.md); unset in a local build. */
  readonly VITE_NAEBKA_VERSION?: string;
}
