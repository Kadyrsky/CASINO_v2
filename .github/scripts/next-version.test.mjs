// Tests for next-version.mjs (docs/versioning.md): node --test .github/scripts/next-version.test.mjs
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BASELINE,
  bump,
  levelOf,
  newestTag,
  nextRelease,
  parseLog,
  parseVersion,
  previewPullRequest,
  pullRequestNumber,
} from './next-version.mjs';

describe('versions', () => {
  it('reads MAJOR.MINOR.PATCH, with or without the v', () => {
    assert.deepEqual(parseVersion('1.4.0'), { major: 1, minor: 4, patch: 0 });
    assert.deepEqual(parseVersion('v10.20.30'), { major: 10, minor: 20, patch: 30 });
    for (const bad of ['1.4', '1.4.0.1', '01.4.0', '1.4.0-rc.1', 'latest', '']) assert.equal(parseVersion(bad), null);
  });

  it('bumps one number and resets the ones after it', () => {
    assert.equal(bump('1.4.2', 'patch'), '1.4.3');
    assert.equal(bump('1.4.2', 'minor'), '1.5.0');
    assert.equal(bump('1.4.2', 'major'), '2.0.0');
    assert.equal(bump('v0.9.9', 'minor'), '0.10.0');
    assert.throws(() => bump('1.4', 'patch'));
    assert.throws(() => bump('1.4.2', 'huge'));
  });

  it('finds the highest version tag, by number rather than by spelling', () => {
    assert.equal(newestTag(['v1.9.0', 'v1.10.0', 'v1.2.3']), 'v1.10.0');
    assert.equal(newestTag(['v2.0.0', 'v10.0.0']), 'v10.0.0');
    assert.equal(newestTag(['release-3', '3.0.0', 'v3', 'v1.0.0-rc.1', 'v1.0.0']), 'v1.0.0');
    assert.equal(newestTag([]), null);
  });
});

describe('how big a change is', () => {
  const pr = (title, branch, labels = []) => levelOf({ title, branch, labels });

  it("goes by the branch for this repository's plain titles", () => {
    assert.deepEqual(pr('Live map: added shrines and patrons', 'feature/live-map-patrons'), {
      level: 'minor',
      reason: 'branch feature/live-map-patrons',
    });
    assert.equal(pr('Music on the live site: commit it', 'fix/music-on-server').level, 'patch');
    assert.equal(pr('Deploy: domain only, behind Cloudflare proxy', 'deploy/domain-only').level, 'patch');
    assert.equal(pr('Something', 'feat/thing').level, 'minor');
  });

  it('does not take "Topic: what changed" for a conventional title', () => {
    assert.deepEqual(pr('Slots: Deadcock theme and a clearer paytable', 'feature/slots-deadlock-theme'), {
      level: 'minor',
      reason: 'branch feature/slots-deadlock-theme',
    });
  });

  it('lets a conventional title say what the branch does not', () => {
    assert.deepEqual(pr('test: WebSocket and chat integration tests', 'feature/ws-chat-tests'), {
      level: 'patch',
      reason: '"test:" title',
    });
    assert.equal(pr('feat(map): shrines', 'fix/anything').level, 'minor');
    assert.equal(pr('Fix: login lockout', 'feature/x').level, 'patch');
    assert.equal(pr('docs: versioning', 'feature/x').level, 'patch');
  });

  it('makes a major of a breaking change', () => {
    assert.deepEqual(pr('feat!: one wallet per player', 'feature/x'), { level: 'major', reason: '"feat!:" title' });
    assert.equal(pr('fix(api)!: amounts in cents', 'fix/x').level, 'major');
    const commit = levelOf({ title: 'refactor: new ledger', body: 'Moves money.\n\nBREAKING CHANGE: balances reset' });
    assert.equal(commit.level, 'major');
  });

  it('uses the kind labels before the branch', () => {
    assert.deepEqual(pr('Better odds', 'fix/odds', ['enhancement']), { level: 'minor', reason: 'label enhancement' });
    assert.equal(pr('Odd bug', 'feature/odds', ['bug']).level, 'patch');
    assert.equal(pr('Both', 'fix/x', ['bug', 'enhancement']).level, 'minor');
    assert.equal(pr('Unknown labels', 'fix/x', ['help wanted', 'javascript', 'constructor']).level, 'patch');
  });

  it("makes Dependabot's updates patches, whatever the dependency's own version did", () => {
    const update = pr('Bump @solidjs/router from 0.15.4 to 2.0.1 in /frontend', 'dependabot/npm_and_yarn/frontend/x', [
      'dependencies',
      'javascript',
    ]);
    assert.deepEqual(update, { level: 'patch', reason: 'label dependencies' });
  });

  it('lets a semver: label overrule everything else', () => {
    assert.deepEqual(pr('Add WebSocket tests', 'feature/ws-chat-tests', ['semver:patch', 'enhancement']), {
      level: 'patch',
      reason: 'label semver:patch',
    });
    assert.equal(pr('fix: tidy', 'fix/x', ['semver:minor']).level, 'minor');
    assert.equal(pr('feat!: big', 'feature/x', ['semver:minor']).level, 'minor');
    assert.equal(pr('Launch', 'fix/x', ['Semver:Major']).level, 'major');
  });

  it('makes anything unmarked a patch', () => {
    assert.deepEqual(levelOf({ title: 'Changing gitattributes for aesthetic reasons' }), {
      level: 'patch',
      reason: 'no feature or breaking change marked',
    });
  });
});

describe('commits on main', () => {
  it("finds the pull request in GitHub's merge and squash subjects", () => {
    assert.equal(pullRequestNumber('Merge pull request #34 from Kadyrsky/feature/realtime-map-3d'), 34);
    assert.equal(pullRequestNumber('Live map: shrines (#64)'), 64);
    assert.equal(pullRequestNumber("Merge branch 'main' into feature/x"), null);
    assert.equal(pullRequestNumber('Changing gitattributes for aesthetic reasons'), null);
  });

  it('reads git log records, oldest first', () => {
    const out = 'bbb\x1fSecond\x1fbody line\n\x1e\naaa\x1fFirst\x1f\x1e\n';
    assert.deepEqual(parseLog(out), [
      { sha: 'aaa', subject: 'First', body: '' },
      { sha: 'bbb', subject: 'Second', body: 'body line' },
    ]);
    assert.deepEqual(parseLog(''), []);
  });
});

// A fake checkout: `commits` newest first, as git log prints them; tags reachable from HEAD and tags on HEAD.
function fakeGit({ commits = [], tags = [], headTags = [], ancestor = true }) {
  return (...args) => {
    if (args[0] === 'tag' && args[1] === '--points-at') return headTags.join('\n');
    if (args[0] === 'tag' && args[1] === '--merged') return [...tags, 'not-a-version'].join('\n');
    if (args[0] === 'merge-base') {
      if (!ancestor) throw new Error('exit 1');
      return '';
    }
    if (args[0] === 'log') {
      fakeGit.range = args.at(-1);
      return commits.map((c) => `${c.sha}\x1f${c.subject}\x1f${c.body ?? ''}\x1e\n`).join('');
    }
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
}

// A fake GitHub API: merged pull requests by number, and which pull requests each commit belongs to.
function fakeGithub(pulls, commitPulls = {}) {
  return async (path) => {
    const pull = /^pulls\/(\d+)$/.exec(path);
    if (pull) return pulls[pull[1]] ?? null;
    const commit = /^commits\/(\w+)\/pulls$/.exec(path);
    if (commit) return (commitPulls[commit[1]] ?? []).map((n) => pulls[n]);
    throw new Error(`unexpected API path ${path}`);
  };
}

const merged = (number, title, branch, labels = []) => ({
  number,
  title,
  merged_at: '2026-11-26T12:00:00Z',
  base: { ref: 'main' },
  head: { ref: branch },
  labels: labels.map((name) => ({ name })),
});

const mergeCommit = (sha, number, branch) => ({
  sha,
  subject: `Merge pull request #${number} from Kadyrsky/${branch}`,
  body: 'The title',
});

describe('the release a push to main makes', () => {
  const pulls = {
    61: merged(61, 'Live map: spectate first', 'fix/live-map-spectate-queue'),
    64: merged(64, 'Live map: shrines and patrons', 'feature/live-map-patrons'),
    70: merged(70, 'Version number under the name', 'feature/version-number'),
    71: merged(71, 'Bump log from 0.4.34 to 0.4.35', 'dependabot/cargo/x', ['dependencies', 'rust']),
  };

  it('starts from the baseline the first time, and tags it too', async () => {
    const git = fakeGit({
      commits: [
        mergeCommit('c70', 70, 'feature/version-number'),
        mergeCommit('c64', 64, 'feature/live-map-patrons'),
        mergeCommit('c61', 61, 'fix/live-map-spectate-queue'),
      ],
    });
    const r = await nextRelease({ git, github: fakeGithub(pulls) });
    assert.equal(fakeGit.range, `${BASELINE.commit}..HEAD`);
    assert.equal(r.version, '1.5.0');
    assert.equal(r.tag, 'v1.5.0');
    assert.equal(r.previousTag, 'v1.4.0');
    assert.equal(r.baselineCommit, BASELINE.commit);
    assert.equal(r.release, true);
    assert.equal(r.level, 'minor');
    assert.deepEqual(
      r.changes.map((c) => [c.ref, c.level]),
      [['#61', 'patch'], ['#64', 'minor'], ['#70', 'minor']],
    );
  });

  it('goes on from the newest tag once there is one', async () => {
    const git = fakeGit({ tags: ['v1.4.0', 'v1.5.0'], commits: [mergeCommit('c71', 71, 'dependabot/cargo/x')] });
    const r = await nextRelease({ git, github: fakeGithub(pulls) });
    assert.equal(fakeGit.range, 'v1.5.0..HEAD');
    assert.deepEqual([r.version, r.previousTag, r.baselineCommit, r.release], ['1.5.1', 'v1.5.0', '', true]);
  });

  it('releases nothing new when HEAD is tagged already (a re-run)', async () => {
    const git = fakeGit({ tags: ['v1.5.0', 'v1.5.1'], headTags: ['v1.5.1'] });
    const r = await nextRelease({ git, github: fakeGithub(pulls) });
    assert.deepEqual([r.version, r.tag, r.release], ['1.5.1', 'v1.5.1', false]);
  });

  it('counts a rebase-merged pull request once, and versions commits pushed straight to main', async () => {
    const git = fakeGit({
      tags: ['v1.5.1'],
      commits: [
        { sha: 'r2', subject: 'Shrine icons' },
        { sha: 'r1', subject: 'Shrine markers' },
        { sha: 'd1', subject: 'feat!: drop the old map', body: '' },
        { sha: 'd2', subject: 'Typo in the README (#12)' },
      ],
    });
    const r = await nextRelease({ git, github: fakeGithub(pulls, { r1: [64], r2: [64] }) });
    assert.deepEqual(
      r.changes.map((c) => [c.ref, c.level]),
      [['d2', 'patch'], ['d1', 'major'], ['#64', 'minor']],
    );
    assert.equal(r.version, '2.0.0');
  });

  it('finds the pull request of a squash merge by its number', async () => {
    const git = fakeGit({ tags: ['v1.5.1'], commits: [{ sha: 's1', subject: 'Version number under the name (#70)' }] });
    const r = await nextRelease({ git, github: fakeGithub(pulls) });
    assert.deepEqual([r.changes[0]?.ref, r.version], ['#70', '1.6.0']);
  });

  it('refuses a baseline that is not in the history', async () => {
    const git = fakeGit({ ancestor: false, commits: [mergeCommit('c70', 70, 'feature/version-number')] });
    await assert.rejects(nextRelease({ git, github: fakeGithub(pulls) }), /baseline commit/);
  });
});

describe('the preview on a pull request', () => {
  const pull = merged(80, 'Poker: side bets', 'feature/side-bets');

  it('bumps the newest tag in its history', () => {
    const p = previewPullRequest({ git: fakeGit({ tags: ['v1.5.0', 'v1.6.2'] }), pull });
    assert.deepEqual([p.tag, p.previousTag, p.level, p.reason], ['v1.7.0', 'v1.6.2', 'minor', 'branch feature/side-bets']);
  });

  it('bumps the baseline before the first tag', () => {
    const p = previewPullRequest({ git: fakeGit({}), pull: merged(81, 'fix: odds rounding', 'feature/x') });
    assert.deepEqual([p.tag, p.previousTag, p.level], ['v1.4.1', 'v1.4.0', 'patch']);
  });
});
