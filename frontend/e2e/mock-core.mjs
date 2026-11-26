// Mock of the Naebka core for testing the realtime map without the real core, live service and bot: the live
// endpoints and a WebSocket hub that streams a simulated match (match 424242, LIVE_FRAME twice a second). No
// dependencies: `node e2e/mock-core.mjs` (from frontend/; MOCK_PORT, default 8081, is where `vp dev` proxies /api and
// /ws to unless CORE_URL says otherwise). The browser tests (playwright.config.ts) start it on their own port.
// It also runs the slots' casino-wide jackpot (see "slots" below): log in with any name and password to spin.
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { gunzipSync } from 'node:zlib';

const PORT = Number(process.env.MOCK_PORT ?? 8081);
const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
// Assets as the live service makes them (the site's /api/live/assets): the zipline cables have heights (z).
const assets = fixture('assets.json');
// The game's own objective positions and heights (from dl_midtown's entity lump); deadlock-api's are stale.
const realObjectives = fixture('objectives.json');
// Heights of the camps, rift spots, urn pads and power-up spawners, from the same entities.
const heights = fixture('heights.json');
// Real heroes' paths where no camera sees them (from saved live broadcasts), every half second: in the Mid-Boss's
// arena, up a tunnel out of it, and in two covered halls. Four heroes replay them, back and forth.
const interiorPaths = fixture('interior_paths.json');
const INSIDE = { 1: 'arena', 7: 'tunnel', 3: 'low hall', 9: 'high hall' };
function replay(path, time) {
  const n = path.length - 1;
  const s = (time * 2) % (2 * n); // half-second steps, forth then back
  const k = s <= n ? s : 2 * n - s;
  const i = Math.min(n - 1, Math.floor(k));
  const f = k - i;
  const [a, b] = [path[i], path[i + 1]];
  return a.map((v, j) => Math.round(v + (b[j] - v) * f));
}
const MATCH_ID = '424242';
const POWERUP_KINDS = ['gun', 'survival', 'casting', 'movement'];

// ---------------------------------------------------------------- heights: the 3D view's map model, raycast down
/** The highest walkable surface (facing up) at world (x, y) between `low` and `high`, or null. */
const surface = (() => {
  try {
    const buf = gunzipSync(readFileSync(new URL('../public/maps/dl_midtown.bin.gz', import.meta.url)));
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const radius = dv.getFloat32(8, true);
    const [z0, z1] = [dv.getFloat32(12, true), dv.getFloat32(16, true)];
    const [nv, nt] = [dv.getUint32(20, true), dv.getUint32(24, true)];
    const V = new Float32Array(nv * 3);
    let o = 32;
    for (let i = 0; i < nv; i++, o += 6) {
      V[i * 3] = -radius + (dv.getUint16(o, true) / 65535) * 2 * radius;
      V[i * 3 + 1] = -radius + (dv.getUint16(o + 2, true) / 65535) * 2 * radius;
      V[i * 3 + 2] = z0 + (dv.getUint16(o + 4, true) / 65535) * (z1 - z0);
    }
    const CELL = 256;
    const n = Math.ceil((2 * radius) / CELL);
    const grid = Array.from({ length: n * n }, () => []);
    const cell = (v) => Math.max(0, Math.min(n - 1, Math.floor((v + radius) / CELL)));
    for (let t = 0; t < nt; t++, o += 12) {
      const [a, b, c] = [dv.getUint32(o, true) * 3, dv.getUint32(o + 4, true) * 3, dv.getUint32(o + 8, true) * 3];
      const ux = V[b] - V[a], uy = V[b + 1] - V[a + 1], uz = V[b + 2] - V[a + 2];
      const vx = V[c] - V[a], vy = V[c + 1] - V[a + 1], vz = V[c + 2] - V[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      if (nz <= 0.5 * Math.hypot(nx, ny, nz)) continue; // walls, ceilings and steep slopes
      const xs = [V[a], V[b], V[c]], ys = [V[a + 1], V[b + 1], V[c + 1]];
      for (let gx = cell(Math.min(...xs)); gx <= cell(Math.max(...xs)); gx++)
        for (let gy = cell(Math.min(...ys)); gy <= cell(Math.max(...ys)); gy++) grid[gy * n + gx].push(a, b, c);
    }
    return (x, y, low = -Infinity, high = Infinity) => {
      const list = grid[cell(y) * n + cell(x)];
      let best = null;
      for (let i = 0; i < list.length; i += 3) {
        const [a, b, c] = [list[i], list[i + 1], list[i + 2]];
        const d = (V[b + 1] - V[c + 1]) * (V[a] - V[c]) + (V[c] - V[b]) * (V[a + 1] - V[c + 1]);
        if (!d) continue;
        const wa = ((V[b + 1] - V[c + 1]) * (x - V[c]) + (V[c] - V[b]) * (y - V[c + 1])) / d;
        const wb = ((V[c + 1] - V[a + 1]) * (x - V[c]) + (V[a] - V[c]) * (y - V[c + 1])) / d;
        const wc = 1 - wa - wb;
        if (wa < 0 || wb < 0 || wc < 0) continue;
        const z = wa * V[a + 2] + wb * V[b + 2] + wc * V[c + 2];
        if (z >= low && z <= high && (best == null || z > best)) best = z;
      }
      return best;
    };
  } catch (e) {
    console.warn('mock: no map model for heights', e.message);
    return () => null;
  }
})();
/** Where a hero walking near a zipline stands: the highest surface below the cable, else nearby. */
function feet(x, y, cable) {
  for (const [dx, dy] of [[0, 0], [48, 0], [-48, 0], [0, 48], [0, -48], [96, 96], [-96, -96], [96, -96], [-96, 96]]) {
    const z = surface(x + dx, y + dy, -600, cable - 60);
    if (z != null) return Math.round(z);
  }
  return Math.round(cable - 400);
}

// ---------------------------------------------------------------- deterministic randomness
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

// ---------------------------------------------------------------- the match
// Each hero's own four abilities, in slot order (from deadlock-api's heroes).
const heroAbilities = fixture('hero_abilities.json');
const heroIds = Object.entries(assets.heroes)
  .filter(([id, h]) => (h.minimap || h.icon) && heroAbilities[id])
  .map(([id]) => +id)
  .slice(0, 12);
// The items the shop sells. The assets also hold removed ones (some under internal names, with other items' art) and
// Street Brawl's own, which no hero in a normal match can have.
const shop = Object.entries(assets.items)
  .filter(([, item]) => item.shop)
  .map(([id, item]) => ({ id: +id, tier: item.tier }));
/** A hero's build: `count` different items the shop sells, two of each tier from the cheapest up. */
function build(count) {
  const items = [];
  for (let k = 0; k < count; k++) {
    const tier = Math.min(4, 1 + Math.floor(k / 2));
    const choices = shop.filter((s) => s.tier === tier && !items.includes(s.id));
    items.push(choices[Math.floor(rnd() * choices.length)].id);
  }
  return items;
}
const NAMES = ['Brass Fox', 'Night Owl', 'Copper', 'Lantern', 'Gearwork', 'Sootfall', 'Marrow', 'Velvet', 'Ash Moth', 'Tinsel', 'Rook', 'Quill'];
const players = heroIds.map((hero, i) => {
  const score = { kills: Math.floor(rnd() * 5), deaths: Math.floor(rnd() * 5), assists: Math.floor(rnd() * 8) };
  return {
    account_id: 1000 + i,
    team: i < 6 ? 0 : 1,
    hero_id: hero,
    name: NAMES[i],
    avatar: null,
    badge: 100 + (i % 6),
    lane: i % 3,
    side: (i % 6) < 3 ? -1 : 1,
    phase: rnd() * Math.PI * 2,
    speed: 0.04 + rnd() * 0.05,
    abilities: heroAbilities[hero],
    items: build(3 + (i % 5)),
    deadUntil: 0,
    start: score, // the score the match starts with, again each time it starts over
    ...score,
    net_worth: 8000 + Math.floor(rnd() * 6000),
  };
});

/** Point at share t (0 south … 1 north) along a lane polyline, and the direction there. */
function along(points, t) {
  const seg = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const d = Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    seg.push(d);
    total += d;
  }
  let want = Math.max(0, Math.min(1, t)) * total;
  for (let i = 1; i < points.length; i++) {
    if (want <= seg[i - 1] || i === points.length - 1) {
      const f = seg[i - 1] ? Math.min(1, want / seg[i - 1]) : 0;
      const [ax, ay, az = 0] = points[i - 1];
      const [bx, by, bz = 0] = points[i];
      const len = seg[i - 1] || 1;
      return { x: ax + (bx - ax) * f, y: ay + (by - ay) * f, z: az + (bz - az) * f, nx: -(by - ay) / len, ny: (bx - ax) / len };
    }
    want -= seg[i - 1];
  }
  return { x: 0, y: 0, z: 0, nx: 0, ny: 0 };
}

const MAX_HP = { guardian: 4500, walker: 9000, base_guardian: 5000, shrine: 5000, patron: 12000, midboss: 52000 };
let oid = 1;
const objectives = realObjectives.map((o) => {
  const max = MAX_HP[o.kind] ?? 5000;
  const hp = o.kind === 'midboss' ? 41000 : Math.round(max * (0.35 + rnd() * 0.65));
  return { id: oid++, ...o, hp, max_hp: max, start_hp: hp };
});

const camps = assets.map.camps.map((c, i) => ({ id: i + 1, x: c.x, y: c.y, z: heights.camps[i] ?? null, kind: c.kind, downUntil: rnd() < 0.3 ? 30 + rnd() * 250 : 0 }));
const urnSpawn = assets.map.urn_spawns?.[0] ?? [0, 0];
const urnSpawnZ = surface(urnSpawn[0], urnSpawn[1], -600, 1500);

// ---------------------------------------------------------------- the clock
// The match is at 15:00 when someone comes to watch, and goes on in real time while anyone does. Once nobody has
// watched for a few seconds it starts over, so it never runs on for hours (but never goes back while someone
// watches: the page drops frames older than the last).
let t0 = Date.now();
let watching = 0;
let idleSince = Date.now();
let lastEvent = { kill: 0, buy: 0 };
const gameTime = () => 900 + (Date.now() - t0) / 1000;

function watch() {
  if (watching++ === 0 && Date.now() - idleSince > 3000) startOver();
}

function unwatch() {
  if (--watching === 0) idleSince = Date.now();
}

function startOver() {
  t0 = Date.now();
  lastEvent = { kill: 0, buy: 0 };
  for (const p of players) Object.assign(p, { deadUntil: 0 }, p.start);
  for (const o of objectives) o.hp = o.start_hp;
}

// ---------------------------------------------------------------- one frame
let tick = 0;

function frame() {
  const time = gameTime();
  tick = Math.round(time * 64);
  const events = [];
  const framePlayers = players.map((p, i) => {
    const lane = assets.map.lanes[p.lane].points;
    const centre = p.team === 0 ? 0.42 : 0.58;
    const t = centre + 0.1 * Math.sin(time * p.speed + p.phase) + (i === 5 || i === 11 ? 0.25 * Math.sin(time * 0.03 + p.phase) : 0);
    const at = along(lane, t);
    // One hero a team rides the zipline (feet about 100 below the cable, as measured on live broadcasts); the others
    // walk beside it, on whatever is below the cable there.
    const riding = i === 4 || i === 10;
    const side = riding ? 0 : p.side * (220 + 120 * Math.sin(time * 0.3 + p.phase));
    let [hx, hy] = [Math.round(at.x + at.nx * side), Math.round(at.y + at.ny * side)];
    let hz = riding ? Math.round(at.z - 100) : null;
    const inside = INSIDE[i] && interiorPaths[INSIDE[i]];
    if (inside) [hx, hy, hz] = replay(inside, time);
    const alive = inside ? true : time >= p.deadUntil;
    const hpShare = alive ? 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(time * 0.4 + p.phase)) : 0;
    return {
      slot: i,
      account_id: p.account_id,
      hero_id: p.hero_id,
      team: p.team,
      level: 14 + (i % 6),
      net_worth: Math.round(p.net_worth + time * 18),
      kills: p.kills,
      deaths: p.deaths,
      assists: p.assists,
      alive,
      respawn_in_s: alive ? null : Math.ceil(p.deadUntil - time),
      ult_ready: i % 3 === 0,
      items: p.items,
      abilities: p.abilities.map((id, k) => ({ id, unlocked: k < 3 || i % 2 === 0, tier: Math.min(3, (i + k) % 4) })),
      x: hx,
      y: hy,
      z: hz ?? feet(hx, hy, at.z),
      hp: Math.round(1800 * hpShare),
      max_hp: 1800,
      souls: 400 + (i * 137) % 1500,
      last_hits: 80 + i * 7,
      denies: i,
      hero_damage: 9000 + i * 811,
      objective_damage: 2000 + i * 301,
    };
  });
  // Now and then someone dies, or buys something.
  if (time - lastEvent.kill > 9) {
    lastEvent.kill = time;
    const victim = players[Math.floor(rnd() * 12)];
    const killer = players.find((q) => q.team !== victim.team && q.lane === victim.lane);
    victim.deadUntil = time + 12;
    victim.deaths++;
    if (killer) killer.kills++;
    events.push({ type: 'kill', time_s: time, victim: victim.account_id, killer: killer?.account_id ?? null, assisters: [] });
  }
  if (time - lastEvent.buy > 4) {
    lastEvent.buy = time;
    const p = players[Math.floor(rnd() * 12)];
    events.push({ type: 'purchase', time_s: time, account_id: p.account_id, item_id: p.items[0] });
  }
  for (const o of objectives) if (o.kind !== 'midboss' && rnd() < 0.02) o.hp = Math.max(Math.round(o.max_hp * 0.1), o.hp - 150);
  const carrier = framePlayers[2];
  const nw = [0, 1].map((team) => framePlayers.filter((p) => p.team === team).reduce((s, p) => s + p.net_worth, 0));
  const vaults = camps.filter((c) => c.kind === 'vault');
  return {
    match_id: MATCH_ID,
    tick,
    game_time_s: time,
    paused: false,
    delay_s: 21,
    minimap: null,
    objectives_mask: null,
    net_worth: nw,
    winning_team: null,
    players: framePlayers,
    objectives: objectives.map(({ start_hp: _start, ...o }) => o),
    urn: carrier.alive
      ? { x: carrier.x, y: carrier.y, z: carrier.z, carrier: carrier.account_id, delivery: assets.map.urn_pads[0], delivery_z: heights.urn_pads[0], value: 950 }
      : { x: urnSpawn[0], y: urnSpawn[1], z: urnSpawnZ, carrier: null, delivery: null, delivery_z: null, value: 950 },
    rift: {
      x: assets.map.rift_spots[1][0],
      y: assets.map.rift_spots[1][1],
      z: heights.rift_spots[1],
      open: true,
      opens_in_s: null,
      progress: [0.25 + 0.2 * Math.sin(time * 0.05) ** 2, 0.15],
      capturers: [1, 1],
      contested: Math.sin(time * 0.2) > 0,
      heroes: [[players[1].hero_id], [players[7].hero_id]],
      closes_in_s: 60 - (time % 60),
    },
    camps: camps.map((c) => ({ id: c.id, x: c.x, y: c.y, z: c.z, respawn_in_s: c.downUntil > time % 335 ? Math.round(c.downUntil - (time % 335)) : null })),
    midboss_respawn_in_s: null,
    midboss_z: -832,
    sinners: vaults.slice(0, 2).map((c, i) => ({ x: c.x, y: c.y, z: c.z, hp: 900 - i * 300, max_hp: 1200 })),
    // Both bridge power-ups drop at once, as in the game, each of a kind; new kinds every 6 minutes here.
    powerups: heights.powerups.map(([x, y, z], i) => ({ x, y, z, kind: POWERUP_KINDS[(Math.floor(time / 360) * 3 + i * 2) % 4] })),
    events,
    received_at: Date.now() / 1000,
  };
}

// ---------------------------------------------------------------- slots and the casino-wide jackpot
// Enough of Soul Reels to see the jackpot work (docs/jackpot.md). Other players lose all the time, so the pool ticks
// up every second or so; someone else hits it every MOCK_JACKPOT_HIT_EVERY seconds (default 180, the first after 45 s;
// 0: never), or at once with POST /api/mock/jackpot/hit. Anyone can log in, with any name and password, and spin:
// spins lose (every third pays a little back, less than it cost), except at 10.00 a line, which always hits the
// jackpot.
const GAME_ID = '5e1f0000-0000-4000-8000-00000000c0de';
const JACKPOT_SEED = 5000;
const CONTRIBUTION_PERCENT = 2;
const cents = (n) => Math.round(n * 100) / 100;
const mask = (name) => (name.length < 3 ? `${name[0] ?? 's'}***` : `${name[0]}***${name.at(-1)}`);
const jackpot = {
  amount: 5432.1,
  generation: 7,
  lastWin: { amount: 18_342.5, generation: 6, winner: 'r***k', at: new Date(Date.now() - 3 * 86_400_000).toISOString() },
};
/** One push function per socket subscribed to "jackpot". */
const jackpotWatchers = new Set();
function publishJackpot(type, extra = {}) {
  const data = { gameId: GAME_ID, amount: cents(jackpot.amount), generation: jackpot.generation, ...extra };
  for (const push of jackpotWatchers) push({ topic: 'jackpot', ts: new Date().toISOString(), type, data });
}
function hitJackpot(winner) {
  jackpot.lastWin = { amount: cents(jackpot.amount), generation: jackpot.generation, winner, at: new Date().toISOString() };
  jackpot.generation++;
  jackpot.amount = JACKPOT_SEED;
  publishJackpot('JACKPOT_WON', { lastWin: jackpot.lastWin });
  return jackpot.lastWin.amount;
}
const OTHERS = ['b***x', 'n***l', 'c***r', 'l***n', 's***l'];
(function othersLose() {
  jackpot.amount = cents(jackpot.amount + Math.ceil(Math.random() * 15) / 100);
  publishJackpot('JACKPOT');
  setTimeout(othersLose, 600 + Math.random() * 1400);
})();
const HIT_EVERY_S = Number(process.env.MOCK_JACKPOT_HIT_EVERY ?? 180);
if (HIT_EVERY_S > 0) {
  setTimeout(function othersHit() {
    hitJackpot(OTHERS[Math.floor(Math.random() * OTHERS.length)]);
    setTimeout(othersHit, HIT_EVERY_S * 1000);
  }, Math.min(45, HIT_EVERY_S) * 1000);
}

const pays = (three, four, five) => ({ 3: three, 4: four, 5: five });
const SYMBOLS = {
  CHERRY: { name: 'Extended Magazine', type: 'REGULAR', pays: pays(4, 10, 40) },
  LEMON: { name: 'Extra Health', type: 'REGULAR', pays: pays(4, 10, 40) },
  BELL: { name: 'Extra Spirit', type: 'REGULAR', pays: pays(8, 25, 80) },
  CLOVER: { name: 'Guardian', type: 'REGULAR', pays: pays(10, 30, 100) },
  GEM: { name: 'Walker', type: 'REGULAR', pays: pays(20, 75, 250) },
  SEVEN: { name: 'Rejuvenator', type: 'REGULAR', pays: pays(40, 150, 600) },
  WILD: { name: 'Hidden King', type: 'WILD', pays: pays(50, 250, 2000) },
  MULT: { name: 'Archmother x2', type: 'MULTIPLIER', pays: {} },
  SCATTER: { name: 'Soul Urn', type: 'SCATTER', pays: {} },
  BONUS: { name: 'Unstable Rift', type: 'BONUS', pays: {} },
};
const LINES = [[1, 1, 1, 1, 1], [0, 0, 0, 0, 0], [2, 2, 2, 2, 2], [0, 1, 2, 1, 0], [2, 1, 0, 1, 2], [0, 0, 1, 2, 2], [2, 2, 1, 0, 0], [1, 0, 0, 0, 1], [1, 2, 2, 2, 1], [1, 0, 1, 2, 1]];
const GAME = {
  id: GAME_ID, name: 'Soul Reels', rows: 3, columns: 5, paylines: LINES, symbols: SYMBOLS, reels: [],
  scatterPays: { 3: 2, 4: 10, 5: 50 }, freeSpinsPerTrigger: 10, minBetPerLine: 0.01, maxBetPerLine: 10,
};
const SERVER_SEED_HASH = createHash('sha256').update('mock server seed').digest('hex');
const pick = (list) => list[Math.floor(Math.random() * list.length)];
let user = null;
let balance = 1000;
let spins = 0;
const rounds = [];

function login(body) {
  const username = String(body?.username || 'player');
  user = { id: 'a5e10000-0000-4000-8000-000000000001', username, email: `${username}@example.test`, role: 'PLAYER', country: 'CZ', dateOfBirth: '1990-01-01', createdAt: new Date().toISOString() };
  return { token: 'mock-token', expiresAt: new Date(Date.now() + 3_600_000).toISOString(), user };
}

/** A grid that pays nothing: the first two reels never share a symbol, and there are no wilds or specials. */
function losingGrid() {
  const first = ['CHERRY', 'LEMON', 'BELL'];
  const second = ['CLOVER', 'GEM', 'SEVEN'];
  return [0, 1, 2, 3, 4].map((c) => [0, 1, 2].map(() => pick(c === 0 ? first : c === 1 ? second : [...first, ...second])));
}

function spin(body) {
  const betPerLine = Number(body?.betPerLine ?? 0.1);
  const bet = cents(betPerLine * LINES.length);
  const grid = losingGrid();
  let winningLines = [];
  let win = 0;
  let jackpotWin = 0;
  let added = 0;
  spins++;
  if (betPerLine >= 10) {
    for (let c = 0; c < 5; c++) grid[c][1] = 'WILD';
    winningLines = [{ paylineId: 1, symbol: 'WILD', count: 5, win: cents(2000 * betPerLine), positions: LINES[0] }];
    jackpotWin = win = hitJackpot(mask(user?.username ?? 'player'));
  } else {
    if (spins % 3 === 0) {
      // Three Extended Magazines on the middle line: 4x the line bet back, less than the spin cost.
      grid[0] = [pick(['LEMON', 'BELL']), 'CHERRY', pick(['LEMON', 'BELL'])];
      grid[1][1] = grid[2][1] = 'CHERRY';
      grid[3][1] = 'GEM';
      win = cents(4 * betPerLine);
      winningLines = [{ paylineId: 1, symbol: 'CHERRY', count: 3, win, positions: LINES[0] }];
    }
    // 2% of what the spin lost goes into the pool, rounded up to a cent.
    added = Math.ceil(Math.round((bet - win) * 100) * (CONTRIBUTION_PERCENT / 100) - 1e-9) / 100;
    jackpot.amount = cents(jackpot.amount + added);
    publishJackpot('JACKPOT');
  }
  balance = cents(balance - bet + win);
  const round = { id: randomUUID(), type: 'spin', bet, win, createdAt: new Date().toISOString() };
  rounds.unshift(round);
  return {
    spinId: round.id, grid, totalBet: bet, totalWin: win, winningLines, scatterCount: 0, freeSpinsAwarded: 0, freeSpinsRemaining: 0,
    isBonusGameTriggered: false, jackpotWin, jackpot: { amount: cents(jackpot.amount), generation: jackpot.generation, added },
    nextState: 'IDLE', hmacHash: randomUUID().replaceAll('-', ''), serverSeedHash: SERVER_SEED_HASH, clientSeed: 'mock', nonce: spins,
    balance, freeSpin: false,
  };
}

class Reply {
  constructor(status, body) {
    this.status = status;
    this.body = body;
  }
}
const needsLogin = (route) => (body, req) => (req.headers.authorization ? route(body, req) : new Reply(401, { code: 'UNAUTHORIZED', detail: 'Log in first' }));

// ---------------------------------------------------------------- HTTP
const summary = () => {
  const f = frame();
  return {
    match_id: MATCH_ID, start_time: Math.floor(t0 / 1000) - 900, elapsed_s: Math.floor(gameTime()), match_mode: 'ranked', game_mode: 'normal',
    region: 'europe', spectators: 31, match_score: 2100, net_worth: f.net_worth, objectives_alive: [12, 12], winning_team: null,
    team_badges: [104, 105], badge: 105, tracked: false,
    players: players.map(({ account_id, team, hero_id, name, avatar, badge }) => ({ account_id, team, hero_id, name, avatar, badge })),
  };
};
const routes = {
  'GET /api/config': () => ({ currencyMode: 'PLAY_MONEY', tokenFiatRate: 0, fiatCurrency: 'EUR', minStakeTokens: 1, maxStakeTokens: 1000, licensedCountries: ['CZ'] }),
  'GET /api/ab/mine': () => ({ visitorId: null, choices: {} }),
  'GET /api/live/assets': () => assets,
  'GET /api/live/directory': () => ({ updated_at: Date.now() / 1000, source: 'mock', total: 1, rank_spread: [], matches: [summary()], bettable: {} }),
  [`GET /api/live/matches/${MATCH_ID}`]: () => ({ match: summary(), bettableMatchId: null, watch: { allowed: true, reason: 'OPEN', minStakeTokens: 0, stakedTokens: 0 } }),
  'POST /api/auth/login': login,
  'POST /api/auth/register': login,
  'POST /api/auth/refresh': needsLogin(() => login(user)),
  'POST /api/auth/logout': () => undefined,
  'GET /api/auth/me': needsLogin(() => user),
  'GET /api/wallet': needsLogin(() => ({ walletId: 'a5e10000-0000-4000-8000-0000000000aa', currency: 'NTK', balance })),
  'GET /api/slots/games': () => [GAME],
  'GET /api/slots/jackpot': () => ({ amount: cents(jackpot.amount), generation: jackpot.generation, seed: JACKPOT_SEED, contributionPercent: CONTRIBUTION_PERCENT, lastWin: jackpot.lastWin }),
  'GET /api/slots/state': needsLogin(() => ({
    gameId: GAME_ID, state: 'IDLE', freeSpinsRemaining: 0, freeSpinBetPerLine: 0, bonus: null, jackpot: cents(jackpot.amount),
    fairness: { serverSeedHash: SERVER_SEED_HASH, clientSeed: 'mock', nonce: spins }, lastSpin: null,
  })),
  'GET /api/slots/rounds': needsLogin(() => ({ items: rounds.slice(0, 8), nextCursor: null })),
  'POST /api/slots/spin': needsLogin(spin),
  'POST /api/mock/jackpot/hit': () => ({ won: hitJackpot(pick(OTHERS)) }),
};
const server = createServer((req, res) => {
  const path = req.url.split('?')[0];
  const route = routes[`${req.method} ${path}`];
  if (route) {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const out = route(raw ? JSON.parse(raw) : undefined, req);
      if (out === undefined) {
        res.writeHead(204);
        return res.end();
      }
      const [status, body] = out instanceof Reply ? [out.status, out.body] : [200, out];
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    return;
  }
  if (req.method === 'POST' && path.startsWith('/api/ab/')) {
    res.writeHead(204);
    return res.end();
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ code: 'NOT_FOUND', detail: `mock: no ${req.method} ${path}` }));
});

// ---------------------------------------------------------------- WebSocket hub (text frames only)
function send(socket, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  const head = body.length < 126 ? Buffer.from([0x81, body.length])
    : body.length < 65536 ? Buffer.from([0x81, 126, body.length >> 8, body.length & 255])
    : Buffer.concat([Buffer.from([0x81, 127, 0, 0, 0, 0]), Buffer.from([(body.length >>> 24) & 255, (body.length >>> 16) & 255, (body.length >>> 8) & 255, body.length & 255])]);
  socket.write(Buffer.concat([head, body]));
}

server.on('upgrade', (req, socket) => {
  if (!req.url.startsWith('/ws')) return socket.destroy();
  const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  let seq = 1;
  const timers = new Map();
  const pushJackpot = (msg) => send(socket, { ...msg, seq: seq++ });
  let buf = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const op = buf[0] & 15;
      let len = buf[1] & 127;
      let off = 2;
      if (len === 126) { len = buf.readUInt16BE(2); off = 4; } else if (len === 127) { len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const masked = buf[1] & 128;
      if (buf.length < off + (masked ? 4 : 0) + len) return;
      const mask = masked ? buf.subarray(off, off + 4) : null;
      const data = Buffer.from(buf.subarray(off + (masked ? 4 : 0), off + (masked ? 4 : 0) + len));
      if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
      buf = buf.subarray(off + (masked ? 4 : 0) + len);
      if (op === 8) return socket.end();
      if (op === 9) { socket.write(Buffer.from([0x8a, 0])); continue; }
      if (op !== 1) continue;
      const msg = JSON.parse(data.toString());
      if (msg.op === 'subscribe' && msg.topic === `watch:${MATCH_ID}` && !timers.has(msg.topic)) {
        watch();
        send(socket, { topic: msg.topic, seq: seq++, type: 'SUBSCRIBED' });
        timers.set(msg.topic, setInterval(() => send(socket, { topic: msg.topic, seq: seq++, ts: new Date().toISOString(), type: 'LIVE_FRAME', data: frame() }), 500));
      } else if (msg.op === 'subscribe') {
        send(socket, { topic: msg.topic, seq: seq++, type: 'SUBSCRIBED' });
        if (msg.topic === 'jackpot') jackpotWatchers.add(pushJackpot);
      } else if (msg.op === 'unsubscribe' && msg.topic === 'jackpot') {
        jackpotWatchers.delete(pushJackpot);
      } else if (msg.op === 'unsubscribe' && timers.has(msg.topic)) {
        clearInterval(timers.get(msg.topic));
        timers.delete(msg.topic);
        unwatch();
      }
    }
  });
  const stop = () => {
    jackpotWatchers.delete(pushJackpot);
    for (const t of timers.values()) {
      clearInterval(t);
      unwatch();
    }
    timers.clear();
  };
  socket.on('close', stop);
  socket.on('error', stop);
});

server.listen(PORT, () => console.log(`mock core on :${PORT}, live match ${MATCH_ID} (${heroIds.length} heroes, ${objectives.length} objectives, ${camps.length} camps)`));
