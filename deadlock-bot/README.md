# deadlock-bot

A small command-line bot that asks Deadlock's game coordinator (Valve's server for the game) about matches, using a Steam account. It is the first piece of the Watcher Fleet: it finds live matches, gets the broadcast link for one, and fetches the official result once the match is over.

It is based on deadlock-api's open-source [public-ingest](https://github.com/deadlock-api/public-ingest) tool and uses the same Steam library ([steam-vent](https://github.com/deadlock-api/steam-vent)) and Deadlock message definitions ([valveprotos](https://github.com/deadlock-api/deadlock-api/tree/master/valveprotos)).

| Command | What it does | Minimum wait between runs |
| --- | --- | --- |
| `login --username <name>` | Logs in once with your password and Steam Guard, then saves a login token | none |
| `active` | Lists live matches from the in-game Watch tab (top 200) as JSON | 1 minute |
| `spectate <match_id>` | Prints the live broadcast URL of a match that is being played now | 5 minutes |
| `result <match_id>` | Prints the official result of a finished match: winner, duration, each player's K/D/A | 1 minute |
| `serve` | Stays logged in and answers HTTP requests with deadlock-api's JSON, for the website's fallback ([below](#server-mode-serve)) | same waits, per request |
| `live <broadcast_url>` | Prints realtime map frames (JSON lines) from a match's broadcast, for testing the live feed | none (no Steam login needed) |
| `logout` | Deletes the saved login token | none |

Add `--force` to skip the wait. The waits are there so the account doesn't look like a bot hammering Valve. deadlock-api's own bots wait longer: about 10 minutes between live lists and 29 minutes between spectates per account.

## Which Steam account to use

- Use a separate bot account, not your main one. deadlock-api's README warns that accounts used this way could be banned. The waits above keep the risk low, but it isn't zero.
- The account needs Deadlock access. A limited Steam account (one that never spent $5) can't join the playtest.
- Don't play Deadlock on the same account while the bot runs: Steam sees Deadlock as running on another computer.

## Setup

1. Install Rust from [rustup.rs](https://rustup.rs).
2. Install the Protocol Buffers compiler (`protoc`), which the build needs:
   - Windows: `winget install --id Google.Protobuf`, or download `protoc-*-win64.zip` from [GitHub releases](https://github.com/protocolbuffers/protobuf/releases) and add its `bin` folder to `PATH`
   - macOS: `brew install protobuf`
   - Linux: `sudo apt install protobuf-compiler libprotobuf-dev` (the second package has the `google/protobuf/*.proto` files the build imports)
3. Build it:

   ```sh
   cd deadlock-bot
   cargo build --release
   ```

   The program is then `target/release/deadlock-bot` (`deadlock-bot.exe` on Windows).

## Use

Log in once. It asks for your password, then Steam Guard: approve the login in the Steam mobile app, or type the code.

```sh
deadlock-bot login --username your_steam_login
```

The password is not saved. Only a login token is kept, in your user's config folder (the command prints where). Treat that token like a password: don't share it or commit it. `deadlock-bot logout` deletes it.

Then:

```sh
deadlock-bot active > live.json
deadlock-bot spectate 125169778
deadlock-bot result 125169778
```

Results go to standard output as JSON and messages go to standard error, so the output can be piped into other programs. To see what is sent to and received from Steam, set `RUST_LOG=debug` first (PowerShell: `$env:RUST_LOG="debug"`).

### Output

`active` uses the same field names as deadlock-api's `GET /v1/matches/active` (without its `*_parsed` fields), so the Watcher can read either source:

```json
[
  {
    "match_id": 125169778,
    "lobby_id": 102135642516701796,
    "start_time": 1793018361,
    "duration_s": null,
    "players": [{ "account_id": 184601350, "team": 0, "hero_id": 86, "abandoned": null }],
    "net_worth_team_0": 52000,
    "net_worth_team_1": 52000,
    "spectators": 5,
    "match_mode": 1,
    "game_mode": 4,
    "...": "..."
  }
]
```

`spectate` prints `{ "match_id", "broadcast_url", "lobby_id" }`. Any Source 2 broadcast parser can read the URL, and so can deadlock-api's live query: `https://api.deadlock-api.com/v1/matches/demo/live/query?broadcast_url=<url>&query=<SQL>`.

`result` prints `match_id`, `start_time`, `duration_s`, `winning_team`, `match_outcome`, `not_scored`, `game_mode`, `match_mode` and one entry per player with `account_id`, `player_slot`, `team`, `hero_id`, `kills`, `deaths`, `assists`, `net_worth` and `abandon_match_time_s`. Add `--save report.meta.bz2` to also keep Valve's raw report file.

## Server mode (`serve`)

```sh
deadlock-bot serve                          # http://127.0.0.1:8090
deadlock-bot serve --listen 0.0.0.0:8090    # inside Docker
```

It logs in on the first request, keeps the Steam session open, and closes it after 15 minutes without requests (`--idle-minutes`). The website's settlement worker and watcher ask it only when deadlock-api answers "too many requests" or is down.

| Route | Answers like deadlock-api's | Cached for |
| --- | --- | --- |
| `GET /v1/matches/active` | `/v1/matches/active` (no `?account_id=` lookup: that answers 400) | 60 s; an older list is still served for 10 minutes if Steam fails |
| `GET /v1/matches/{id}/metadata` | `/v1/matches/{id}/metadata`: `{"match_id", "match_info": {...}}` with the fields of `result` | forever once known; "not finished yet" for 60 s |
| `GET /v1/matches/{id}/live/url` | `/v1/matches/{id}/live/url` | 1 hour |
| `GET /healthz` | (bot status: logged in, connected, last error) | no |

Status codes, chosen so deadlock-api clients handle them already:

* `404`: the match isn't finished or processed yet (same as deadlock-api).
* `429` + `Retry-After`: the wait for that kind of request isn't over. The waits are the same as the commands' and are shared with them through the request log.
* `503` + `Retry-After`: no saved login yet (300 s), Steam login failed (backs off from 1 to 10 minutes, since repeated logins look the most like a bot), or the game coordinator is busy (60 s).
* `502`: anything else went wrong; the next request opens a new Steam session.

Set `DEADLOCK_BOT_TOKEN` to require `Authorization: Bearer <token>` on every route except `/healthz`. The server has no TLS: keep it on a private network (Docker Compose does), or behind a TLS tunnel with the token set.

### Live map feeds

With `REDIS_URL` set, `serve` also follows match broadcasts for the website's realtime map (`src/feeds.rs`):
the watcher's tracked matches first, then any match a viewer has open, up to `DEADLOCK_BOT_MAX_FEEDS` (12). Each
broadcast is read by the [haste](https://github.com/blukai/haste) parser on its own thread (`src/live.rs`) and
sampled twice a second into a frame: every hero's position and height, health, level, souls (net worth and
unspent), K/D/A, last hits, denies, damage, items, abilities (unlocked, points) and ultimate; the objectives still
standing; the Soul Urn (on the ground or carried, delivery pad, value); the Unstable Rift (appearing with a
countdown, then open with each team's progress, who is on it, whether it is contested and when it closes); the
neutral camps' respawn timers, the Sinner's Sacrifices' health, the Mid-Boss respawn and the bridge power-ups (with
their kind: gun, survival, casting or movement); and
kill, purchase, level-up, ability, objective, Mid-Boss, urn and rift events. Everything on the map has its height
(`z`) as well as x and y. Frames go to Redis (`live:frame:{id}` and the channel `naebka:live-frames`).

Broadcast URLs come from deadlock-api's public list (`/v1/matches/live/urls`). Only matches missing from it are
spectated with the bot account, within the 5-minute spectate wait. One feed uses about 30 MB and a few percent of
a CPU core.

Things learned from live broadcasts:

* Deadlock's position grid is now 128 × 128 cells of 512 units, so the origin is at cell 64 (haste's helper still
  assumes 64 × 64).
* Heights (z) use the same cells: z = cell × 512 + offset − 32768. Checked against heights sent without cells: the
  bridge power-ups read 912 (deadlock-api's map: 912), the Sinner's Sacrifices on the Chinatown roof 2496 (their
  camp timer: 2499), the sunken ones −32 (−32), the Mid-Boss −823 (−832), the open rift 420 (deadlock-api: 420). A
  hero's z is its feet, so frames put heroes on bridges, roofs and ziplines and in tunnels; streets are at about 250
  to 500. Camps (and the Mid-Boss's spot, `midboss_z`) take theirs from the camp timers, which are plain vectors; they
  match deadlock-api's camp heights to 0.2.
* Valve sends the objective bitmasks only when they change, so a feed that joins mid-match has none until the next
  objective falls (the watcher keeps the live list's until then).
* Since early November 2026 broadcasts declare a field with a multi-argument template type
  (`CNetworkUtlVectorBase< CNetworkUtlVectorBase< EEvent, NetworkVar_m_vecActiveEvents , -1, int > >`), which
  upstream haste can't parse ("unknown char ,"): every feed failed. `vendor/haste_vartype` is haste's type parser with
  that fixed, patched in through `[patch]` in `Cargo.toml`. Drop it once upstream haste handles these types.
* Camps: the game rules hold one timer per camp (`m_vecNeutralCampTimerOrigins`, `m_vecNeutralCampNextSpawnTimes`,
  `m_vecNeutralCampTimerIsMidBoss`), standing exactly on deadlock-api's camp positions. A timer is -1 while the camp is
  up; clearing it sets the respawn time: 85 s for small camps, 290 s medium, 335 s hard, 300 s for a Sinner's
  Sacrifice, 7 minutes for the Mid-Boss.
* The rift: its spawner stands on the spot for exactly 5126 ticks (80 s) before the capture point opens, so the
  countdown is the spawner's `m_flCreateTime` + 80 s. Once open, the game rules have its spot
  (`m_vKothCashInCurrentLocation`) and `m_timeKothGiveUp`, a minute later. A capture sets `m_nKothScoringTeam` and
  `m_timeKothScoring`.
* The urn falls from the sky for about 12 s when it spawns (the bridge power-ups appear at the same moment), and its
  delivery pad switches on when it lands.
* Bridge power-ups: each bridge's spawner (`CCitadel_PickupItemSpawner`) says only whether one is waiting
  (`m_bPowerupActive`; both drop at once, `m_tNextDropTime` says when next). The power-up itself is a
  `CCitadel_Pickup_Modifier` on the spawner's spot, one per bridge all match: each drop gives it a new kind, its vdata
  subclass in `m_nSubclassID` (the game's hash of the subclass's name, as deadlock-api's item ids: `gun_powerup_pickup`
  is 201785745), and shows it; taking it hides it again (`m_fEffects` 32) with its last kind kept. So a waiting
  power-up's kind is that of the pickup on its spot. Every one followed on five live broadcasts had its kind.
* Shrines (`CCitadel_Destroyable_Building`, kind `shrine`): two per team, on their pedestals in the base at z 980
  (Hidden King) and 1000 (Archmother), 5000 health each, no `m_iLane`. A destroyed shrine's entity is removed. The
  patron (`CNPC_Boss_Tier3`) keeps one entity through both phases (`m_ePhase` 0, then 1). The
  `CNPC_Boss_Tier3Core` seen over a dead patron, 350 units up, had no health or team (frames list objectives only
  while they have health).

`deadlock-bot live <broadcast_url>` prints the frames as JSON lines, which is the quickest way to check a patch didn't
break anything.

### Docker

The root `docker-compose.yml` has it as an optional service:

```sh
docker compose --profile bot up --build -d
docker compose run --rm deadlock-bot login --username your_bot_login   # once: password + Steam Guard
```

The login token and request log live in the `botdata` volume (`DEADLOCK_BOT_HOME=/data`), so they survive restarts and image rebuilds. The image builds on x86-64 and ARM.

### Running it for free

The bot needs a machine that stays on and keeps an outbound connection to Steam. It uses about 10 MB of memory and almost no CPU or traffic.

| Where | Notes |
| --- | --- |
| Oracle Cloud Always Free | ARM VM with 2 CPUs and 12 GB of memory: enough for the whole site plus the bot. Needs a card at signup; ARM capacity is sometimes unavailable. Oracle may reclaim a free VM that stays under 20% CPU, network and memory for 7 days, so running the whole site there also keeps it from looking idle. |
| Google Cloud e2-micro | Free in us-west1, us-central1 and us-east1, 1 GB of memory: enough for the bot alone. Build the image elsewhere: 1 GB is too little to compile it. |
| A PC or Raspberry Pi you already have | Free if it stays on. |

Avoid free tiers that sleep when idle (the Steam session dies) and scheduled CI jobs (each run logs in from a new IP, which looks like a bot).

## Status

Tested against Steam on 29 Oct 2026: `active`, `result` and `serve` (live list, a finished match's result identical to deadlock-api's, and the 429 wait) all work. Unit tests: `cargo test`.

If Valve changes the game's messages, update the `valveprotos` revision in `Cargo.toml` to a newer commit of deadlock-api.
