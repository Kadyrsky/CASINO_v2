# Version numbers

Naebka's version is `MAJOR.MINOR.PATCH` ([Semantic Versioning](https://semver.org)), shown under its name in the
site's header, for example **v1.5.0**. Every push to `main` is tested, built and deployed
([deploy/README.md](../deploy/README.md)), so every merge to `main` is a release and gets the next number by itself.
Nobody edits a version anywhere.

## What the three numbers mean here

| Goes up | When the release has | For example |
|---|---|---|
| MAJOR (2.0.0) | a change that breaks something players, or anything using the site, rely on | balances or accounts reset, a game or page taken away, the API changed so that old clients stop working |
| MINOR (1.5.0) | something new that works with everything before it | a game, a page, a map view, a setting, an admin tool |
| PATCH (1.4.1) | nothing new to use: changes to what is there | fixes, security and dependency updates, deploy changes, tests, docs |

A bump resets the numbers after it (1.4.2 → 1.5.0 → 2.0.0). A number is never used for two builds, so even a
docs-only merge is a patch: it is deployed as a new build.

## Where the version is

* **Git tags** `vX.Y.Z` on `main` are the only record of it. Nothing in the repository holds the current number:
  `frontend/package.json`, `core/pom.xml`, `live/pyproject.toml` and `deadlock-bot/Cargo.toml` still have the 0.1.0
  they were created with, and nothing reads it.
* **GitHub releases**, one for each tag, list the pull requests merged since the previous one.
* **Images**: `ghcr.io/kadyrsky/casino_v2-{core,live}:X.Y.Z`, as well as `:<commit sha>` and `:latest`.
* **The header**: CI passes the number to `core/Dockerfile` as `NAEBKA_VERSION`, which hands it to the frontend build
  as `VITE_NAEBKA_VERSION` (`frontend/src/lib/version.ts`), so it is part of the built site. A local build shows
  **dev**. To give one a number (after `git fetch --tags`):

  ```bash
  docker compose build --build-arg NAEBKA_VERSION=$(git describe --tags) core
  ```

## How big each merge is

What counts is the pull request: its labels, title and branch, not the commits in it or its description. For a commit
pushed straight to `main`, its message. The first rule that applies decides:

| | If the pull request has | It is a |
|---|---|---|
| 1 | a `semver:major`, `semver:minor` or `semver:patch` label | that |
| 2 | a `!` in a conventional title: `feat!: …`, `fix(api)!: …` | major |
| 3 | a [conventional](https://www.conventionalcommits.org) title `feat: …` or `feat(scope): …` | minor |
| | any other conventional type: `fix`, `perf`, `refactor`, `revert`, `docs`, `style`, `test`, `build`, `ci`, `chore` | patch |
| 4 | an `enhancement` label | minor |
| | a `bug`, `dependencies` or `documentation` label | patch |
| 5 | a `feature/…` or `feat/…` branch | minor |
| 6 | anything else: `fix/…` and `deploy/…` branches, Dependabot's updates | patch |

So pull requests work as they are made here now: a `feature/…` branch is a minor, anything else a patch. A title like
"Slots: Deadcock theme" isn't taken for a conventional one, because only the standard types count. A commit pushed
straight to `main` is also a major if its message has a `BREAKING CHANGE:` line. Descriptions aren't read because
Dependabot's quote the dependency's own release notes, BREAKING CHANGE lines included.

When the branch says the wrong thing, for example a `feature/…` branch that only adds tests, retitle the pull request
(`test: …`) or label it `semver:patch` before merging. A major only ever happens on purpose: it needs the label or a `!`
title.

The `semver:` labels aren't in the repository yet. Create them once:

```bash
gh label create semver:major --color B60205 --description "Breaks something: the next version is a major"
gh label create semver:minor --color 0E8A16 --description "Something new: the next version is a minor"
gh label create semver:patch --color C5DEF5 --description "Nothing new to use: the next version is a patch"
```

When one run releases several merges, the version goes up once, by the biggest of them: 1.4.0 plus a fix and a feature
is 1.5.0. That happens when a run fails, or when pushes come quickly: runs on `main` wait for the one before them, and
a newer push takes the place of a run that is still waiting.

## In CI

`.github/workflows/ci-cd.yml`, on a push to `main`:

1. **version**, alongside the tests, runs `.github/scripts/next-version.mjs`. It takes the newest `vX.Y.Z` tag in
   `main`'s history, reads the pull requests merged since through the GitHub API, and works out the next number. Its
   summary lists each merge, its bump and why.
2. **images** builds the core and live images with that number once every test has passed, and pushes them.
3. **release** tags the commit `vX.Y.Z` and publishes the GitHub release.
4. **deploy** puts it on the server.

On a pull request the version job only previews: its summary and an annotation say which number merging it would
release, and why (counting that pull request alone). Its tests (`node --test .github/scripts/next-version.test.mjs`)
run every time.

* **No loop.** Nothing pushes a commit to `main`. The workflow runs for branch pushes and pull requests, not for tags
  or releases, and GitHub starts no runs for the tags and releases that `GITHUB_TOKEN` creates anyway.
* **Re-running a run** is safe. A commit that has its tag already builds that version again and releases nothing new;
  the release step skips whatever it did the first time.
* **A failed run**, for example a failing test, releases nothing. The next push to `main` releases its merges too.

## Where 1.4.0 came from

There was no version before this: no tags or releases, and every manifest still had the 0.1.0 it was created with. So
`main`'s history (`git log --first-parent main`) was gone through merge by merge, and each merge was numbered by what it
changed:

* Until the site went live it was in initial development, 0.y.z, SemVer's "anything may change" stage.
* **1.0.0** is #24, the first deploy to poker.naebka.win on 12 November 2026. SemVer's FAQ: software used in
  production should be 1.0.0.
* Nothing since has broken anything players use, so it is still 1.x: four features and four smaller changes later,
  **1.4.0** at the merge of #34 (`a411fea`).

| Merged | Pull request | What it changed | Bump | Version |
|---|---|---|---|---|
| 1 Nov | #1 Design documents and project setup | the start | | 0.1.0 |
| 1 Nov | #15 The feature chain (#2–#13): accounts and wallet, live betting, slots, poker, admin, KYC, web3, Steam bot, live map | features | minor | 0.2.0 |
| 1 Nov | `71b0616` .gitattributes | chore | patch | 0.2.1 |
| 9 Nov | #18 Live map: objectives, broadcast fix | feature | minor | 0.3.0 |
| 9 Nov | #19 Slots: Deadlock theme, clearer paytable | feature | minor | 0.4.0 |
| 9 Nov | #20 The core serves the frontend instead of nginx | same site, packaged differently | patch | 0.4.1 |
| 9 Nov | #21 Test coverage | tests | patch | 0.4.2 |
| 9 Nov | #22 A/B tests, Customize panel, feedback, Deadlock themes | feature | minor | 0.5.0 |
| 12 Nov | #23 Sound, music and the taste test | feature | minor | 0.6.0 |
| 12 Nov | #24 CI/CD and the first deploy to poker.naebka.win | in production | 1.0 | **1.0.0** |
| 12 Nov | #25 Deploy: port 443 shared with the VPN | fix | patch | 1.0.1 |
| 12 Nov | #26 Deploy: domain only, behind Cloudflare | fix | patch | 1.0.2 |
| 12 Nov | #29 Music on the live site | fix | patch | 1.0.3 |
| 12 Nov | #30 Admin charts view, a file copy of all feedback | feature | minor | 1.1.0 |
| 24 Nov | #31 Play-money notice | feature | minor | 1.2.0 |
| 24 Nov | #32 WebSocket and chat integration tests | tests | patch | 1.2.1 |
| 24 Nov | #33 Security: CSP, API docs off in production, sign-up limit, dependency scans | a feature (the sign-up limit) and fixes | minor | 1.3.0 |
| 24 Nov | #34 Live map: 2.5D and 3D views | feature | minor | **1.4.0** |

The rules in this file would have numbered a few of these differently, because they only see labels, titles and
branches: #20, #21 and #32 came from `feature/…` branches, so they would have been minors (today they would get
`semver:patch`), and nothing tells the rules when a site goes into production. Replayed on their own, they end at
0.13.0.

The first release tags `a411fea` v1.4.0 (`BASELINE` in the script) and numbers everything merged after it. From then
on only the tags count.
