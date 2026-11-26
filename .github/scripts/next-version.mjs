// Works out Naebka's version for the CI/CD workflow's version job (docs/versioning.md). Node 22, git and the GitHub
// API; no packages.
//
// The version is the newest vMAJOR.MINOR.PATCH tag on main. Every merge to main is deployed, so every merge is a
// release and goes up by at least a patch; levelOf() decides from each pull request's labels, title and branch
// whether it is a minor or a major. Merges released together (one run waited for another) go up once, by the
// biggest of them.
//
//   push to main   looks at everything merged since the newest tag and sets the step outputs version (1.5.0),
//                  tag (v1.5.0), previous_tag, baseline_commit (the very first release only) and release (false when
//                  HEAD is tagged already, as on a re-run)
//   pull request   previews the version merging it would make, in the run's summary
//
// Locally, from a checkout with the tags:
//   GITHUB_REPOSITORY=Kadyrsky/CASINO_v2 GITHUB_TOKEN=$(gh auth token) node .github/scripts/next-version.mjs
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * Where the numbering starts. There was no version before, so main's history was replayed with the rules below and
 * the merge of #34 came out as 1.4.0 (docs/versioning.md). Used only while no tag exists: the first release tags this
 * commit v1.4.0, and from then on the tags are all that count.
 */
export const BASELINE = { version: '1.4.0', commit: 'a411fea04f4520f501e2a0a0a0d3be9cb50d6413' };

const LEVELS = ['patch', 'minor', 'major'];

/** "1.4.0" or "v1.4.0" → { major, minor, patch }; anything else → null. */
export function parseVersion(text) {
  const m = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(String(text).trim());
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) } : null;
}

/** The version after a change of this size: a major resets the minor and patch, a minor resets the patch. */
export function bump(version, level) {
  const v = parseVersion(version);
  if (!v) throw new Error(`not a MAJOR.MINOR.PATCH version: ${version}`);
  if (level === 'major') return `${v.major + 1}.0.0`;
  if (level === 'minor') return `${v.major}.${v.minor + 1}.0`;
  if (level === 'patch') return `${v.major}.${v.minor}.${v.patch + 1}`;
  throw new Error(`not a bump level: ${level}`);
}

/** The biggest of some changes (patch < minor < major). */
export function biggest(levels) {
  return levels.reduce((a, b) => (LEVELS.indexOf(b) > LEVELS.indexOf(a) ? b : a), 'patch');
}

const compare = (a, b) => a.major - b.major || a.minor - b.minor || a.patch - b.patch;

/** The highest vMAJOR.MINOR.PATCH among some tag names (other tags are ignored), or null. */
export function newestTag(tags) {
  let best = null;
  for (const tag of tags) {
    const v = tag.startsWith('v') ? parseVersion(tag) : null;
    if (v && (!best || compare(v, best.v) > 0)) best = { tag, v };
  }
  return best?.tag ?? null;
}

// A Conventional Commits title: "feat: …", "fix(map): …", "feat!: …". Only the standard types, because titles here
// are often "Topic: what changed" ("Slots: Deadcock theme…"), which isn't one.
const CONVENTIONAL = /^(feat|fix|perf|refactor|revert|docs|style|test|build|ci|chore)(?:\([^)]*\))?(!)?:\s/i;

// Labels that say what kind of change a pull request is: GitHub's own and Dependabot's.
const TYPE_LABELS = new Map([
  ['enhancement', 'minor'],
  ['bug', 'patch'],
  ['dependencies', 'patch'],
  ['documentation', 'patch'],
]);

/**
 * How big one change is, and why: a pull request's { title, labels, branch }, or for a commit pushed straight to main
 * { title: its subject, body: the rest of its message }. The first rule that applies decides:
 *   1. a semver:major, semver:minor or semver:patch label: that
 *   2. "!" in a conventional title ("feat!: …"), or a BREAKING CHANGE: line in a commit pushed to main: major
 *   3. a conventional title: "feat: …" is a minor, any other type ("fix:", "docs:", "test:", …) a patch
 *   4. an enhancement label: minor; bug, dependencies or documentation: patch
 *   5. a feature/… or feat/… branch: minor
 *   6. anything else (fix/…, deploy/…, Dependabot's branches): patch
 * Pull requests' descriptions aren't read: Dependabot's quote the dependency's own release notes, BREAKING CHANGE
 * lines and all.
 */
export function levelOf({ title = '', body = '', labels = [], branch = '' }) {
  const names = labels.map((l) => l.toLowerCase());
  const semver = names.filter((n) => /^semver:(major|minor|patch)$/.test(n)).map((n) => n.slice('semver:'.length));
  if (semver.length) return { level: biggest(semver), reason: `label semver:${biggest(semver)}` };

  const conventional = CONVENTIONAL.exec(title.trim());
  if (conventional?.[2]) return { level: 'major', reason: `"${conventional[1].toLowerCase()}!:" title` };
  if (/^BREAKING[ -]CHANGE:/m.test(body)) return { level: 'major', reason: 'BREAKING CHANGE: in the commit message' };
  if (conventional) {
    const type = conventional[1].toLowerCase();
    return { level: type === 'feat' ? 'minor' : 'patch', reason: `"${type}:" title` };
  }

  const typed = names.filter((n) => TYPE_LABELS.has(n));
  if (typed.length) {
    const level = biggest(typed.map((n) => TYPE_LABELS.get(n)));
    return { level, reason: `label ${typed.find((n) => TYPE_LABELS.get(n) === level)}` };
  }
  if (/^feat(ure)?\//i.test(branch)) return { level: 'minor', reason: `branch ${branch}` };
  return { level: 'patch', reason: branch ? `branch ${branch}` : 'no feature or breaking change marked' };
}

/** The pull request a commit on main merged, from the subjects GitHub writes: merge commits and squash merges. */
export function pullRequestNumber(subject) {
  const merge = /^Merge pull request #(\d+) from /.exec(subject);
  if (merge) return Number(merge[1]);
  const squash = /\(#(\d+)\)$/.exec(subject.trim());
  return squash ? Number(squash[1]) : null;
}

/** The commits `git log --format=%H%x1f%s%x1f%b%x1e` printed, oldest first. */
export function parseLog(out) {
  return out
    .split('\x1e')
    .filter((record) => record.trim())
    .map((record) => {
      const [sha = '', subject = '', body = ''] = record.replace(/^\n/, '').split('\x1f');
      return { sha: sha.trim(), subject: subject.trim(), body: body.trim() };
    })
    .reverse();
}

const lines = (text) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

/** The last release in HEAD's history: its newest version tag, or BASELINE before there is one. */
function lastRelease(git, baseline) {
  const latest = newestTag(lines(git('tag', '--merged', 'HEAD')));
  if (latest) return { tag: latest, version: latest.slice(1), from: latest };
  return { tag: null, version: baseline.version, from: baseline.commit };
}

/** The merged pull request (into `branch`) a commit came from, for merges whose subject doesn't say (rebase). */
async function mergedPullRequestOf(github, sha, branch) {
  const pulls = (await github(`commits/${sha}/pulls`)) ?? [];
  return pulls.find((p) => p.merged_at && p.base?.ref === branch)?.number ?? null;
}

/**
 * The release a push to main makes. `git(...args)` runs git in the checkout and returns what it printed;
 * `github(path)` GETs repos/{owner}/{repo}/{path} from the GitHub API (null for a 404).
 */
export async function nextRelease({ git, github, baseline = BASELINE, branch = 'main' }) {
  const unchanged = (tag, changes = []) => {
    const version = tag.slice(1);
    return { version, tag, previousTag: tag, baselineCommit: '', release: false, level: null, changes };
  };
  // Released already (a re-run): build the same version again, and release nothing new.
  const tagged = newestTag(lines(git('tag', '--points-at', 'HEAD')));
  if (tagged) return unchanged(tagged);

  const last = lastRelease(git, baseline);
  if (!last.tag) {
    try {
      git('merge-base', '--is-ancestor', baseline.commit, 'HEAD');
    } catch {
      throw new Error(`No version tag yet, and the baseline commit ${baseline.commit} isn't in HEAD's history.`);
    }
  }

  const changes = [];
  const seen = new Set();
  const log = git('log', '--first-parent', '--format=%H%x1f%s%x1f%b%x1e', `${last.from}..HEAD`);
  for (const commit of parseLog(log)) {
    const number = pullRequestNumber(commit.subject) ?? (await mergedPullRequestOf(github, commit.sha, branch));
    const pull = number == null ? null : await github(`pulls/${number}`);
    if (pull?.merged_at) {
      if (seen.has(pull.number)) continue; // a rebase merge puts each of the pull request's commits on main
      seen.add(pull.number);
      const change = { title: pull.title, labels: pull.labels.map((l) => l.name), branch: pull.head.ref };
      changes.push({ ref: `#${pull.number}`, title: pull.title, ...levelOf(change) });
    } else {
      const change = { title: commit.subject, body: commit.body };
      changes.push({ ref: commit.sha.slice(0, 7), title: commit.subject, ...levelOf(change) });
    }
  }

  if (!changes.length) return unchanged(`v${last.version}`);
  const level = biggest(changes.map((c) => c.level));
  const version = bump(last.version, level);
  const baselineCommit = last.tag ? '' : baseline.commit;
  return { version, tag: `v${version}`, previousTag: `v${last.version}`, baselineCommit, release: true, level, changes };
}

/** The version merging a pull request would release, from the newest tag in its history and its own change. */
export function previewPullRequest({ git, pull, baseline = BASELINE }) {
  const last = lastRelease(git, baseline);
  const change = levelOf({ title: pull.title, labels: pull.labels.map((l) => l.name), branch: pull.head.ref });
  const version = bump(last.version, change.level);
  return { version, tag: `v${version}`, previousTag: `v${last.version}`, ...change };
}

function githubApi(env) {
  const token = env.GITHUB_TOKEN ?? env.GH_TOKEN;
  if (!env.GITHUB_REPOSITORY || !token) {
    throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are needed to read the pull requests.');
  }
  const base = `${env.GITHUB_API_URL ?? 'https://api.github.com'}/repos/${env.GITHUB_REPOSITORY}/`;
  return async (path) => {
    const res = await fetch(base + path, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'naebka-ci-version',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub API ${path}: HTTP ${res.status} ${await res.text()}`);
    return res.json();
  };
}

const cell = (text) => text.replace(/\|/g, '\\|');

async function main(env = process.env) {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
  const report = [];
  let outputs;

  if (env.GITHUB_EVENT_NAME === 'pull_request') {
    const { pull_request: pull } = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
    const p = previewPullRequest({ git, pull });
    report.push(`### Merging #${pull.number} releases ${p.tag}`, '');
    report.push(`A ${p.level} after ${p.previousTag}: ${p.reason} (docs/versioning.md).`);
    console.log(`::notice title=Version::Merging this releases ${p.tag}: a ${p.level} (${p.reason}).`);
    outputs = { version: p.version, tag: p.tag, previous_tag: p.previousTag, baseline_commit: '', release: false };
  } else {
    const r = await nextRelease({ git, github: githubApi(env) });
    if (r.release) {
      report.push(`### ${r.tag}: a ${r.level} after ${r.previousTag}`, '');
      if (r.baselineCommit) report.push(`The first release: it also tags ${r.baselineCommit.slice(0, 7)} ${r.previousTag}.`, '');
      report.push('| | Merged | Bump | Why |', '|---|---|---|---|');
      for (const c of r.changes) report.push(`| ${c.ref} | ${cell(c.title)} | ${c.level} | ${cell(c.reason)} |`);
    } else {
      report.push(`### ${r.tag}`, '', 'Nothing new since that release: this run builds it again.');
    }
    const { version, tag, previousTag: previous_tag, baselineCommit: baseline_commit, release } = r;
    outputs = { version, tag, previous_tag, baseline_commit, release };
  }

  console.log(report.join('\n'));
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${report.join('\n')}\n`);
  if (env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT, Object.entries(outputs).map(([k, v]) => `${k}=${v}\n`).join(''));
  } else {
    console.log(JSON.stringify(outputs));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`::error title=Version::${error.message}`);
    process.exit(1);
  });
}
