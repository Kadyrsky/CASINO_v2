# Naebka

Live betting on real public **Deadlock** matches, plus **slots** and multiplayer **No-Limit Hold'em**, all on one
token wallet with an append-only ledger. Implementation of the group's design documents in this folder
(High-Level Design, System Architecture, Technical Design, LLD, Database Design, Frontend, Risks).

Runs in **play-money mode**: tokens are free and have no cash value.

## Run it

Requirements: Docker Desktop. Nothing else needs to be installed.

```bash
docker compose up --build
```

Open <http://localhost:8080>, register (18+, licensed country), and you start with 1,000 NTK.
To withdraw, verify your identity under **Profile & verification** in the account menu (see [KYC](#kyc)).
Live matches appear within ~10 s: the watcher picks fresh ranked games from `api.deadlock-api.com`.

| Service | Port (host) | What it is |
|---|---|---|
| `core` | 8080, 8081 | Spring Boot: serves the SolidJS frontend, `/api` and `/ws` (Swagger UI: <http://localhost:8081/api/docs>) |
| `postgres` | 55432 | PostgreSQL 17 (non-default port so it doesn't clash with a local install) |
| `redis` | 56379 | Redis 7: message broker and WebSocket fan-out |
| `watcher` | – | Python: polls the Deadlock API and publishes normalized match events |
| `odds-engine` | – | Python: prices markets from the event stream |
| `deadlock-bot` | – | Optional (`--profile bot`). Rust Steam bot: follows match broadcasts for the [realtime map](#live-matches-and-the-realtime-map) and answers when deadlock-api says "too many requests" ([below](#steam-bot-fallback)) |

The admin account (manual-review queue and integrity dashboard at `/admin`) comes from `.env.example`
(`NAEBKA_ADMIN_USERNAME` / `NAEBKA_ADMIN_PASSWORD`). Copy it to `.env` to change values.

**Production** (<https://poker.naebka.win>): every push to `main` is tested, built and deployed by GitHub Actions;
see [deploy/README.md](deploy/README.md).

## MetaMask + Sepolia deposits and withdrawals (web3)

Players connect MetaMask, deposit **Sepolia test ETH** to get play tokens (0.001 ETH = 100 NTK by default), and
withdraw tokens back to their wallet as Sepolia ETH. Sepolia ETH has no value, so the platform stays in `PLAY_MONEY`
mode. It follows the course web3 lab: the same Remix settings, the Sepolia chain check (11155111 / `0xaa36a7`), and
the connection safeguards from the lab's `shared/wallet.js` (ported to `frontend/src/lib/eth.ts`).

Deposits are off until a cashier contract address is configured; withdrawals also need an operator key.

### The contract: `contracts/src/NaebkaCashier.sol`

| Function | Who and what |
|---|---|
| `deposit()` | Anyone, 0.0001–0.05 ETH. Emits `Deposited(player, amount)`, which the core credits. Plain transfers are rejected. |
| `payout(to, amount, withdrawalId)` | The **operator** (the server's key) or the owner. At most 0.05 ETH per payout and `dailyPayoutLimit` (0.5 ETH) per UTC day; each `withdrawalId` is paid once. |
| `pause()` / `unpause()` | The operator or the owner can pause (deposits and payouts stop); only the owner resumes. |
| `setOperator`, `setDailyPayoutLimit`, `fund`, `withdrawHouse` | Owner only. |
| `transferOwnership` → `acceptOwnership` | Two steps, so ownership can't be lost to a typo. |

The operator exists so the server never holds the owner key: the owner stays in MetaMask, and a leaked server key
could pay out at most the daily limit before someone pauses the contract.

Tests (17, Hardhat; no local Node needed):

```bash
docker run --rm -v "$PWD/contracts:/app" -w /app node:22-alpine sh -c "npm ci && npx hardhat test"
```

### 1. Deploy the contract (once)

**From Remix** (as in the lab):

1. Open `contracts/src/NaebkaCashier.sol` in [Remix](https://remix.ethereum.org). Compiler **0.8.24**, optimiser on,
   **200 runs**, EVM **Shanghai**.
2. Test in Remix VM first: `deposit` with Value 0.001 ether works; Value 0 or 1 ether reverts `AmountOutOfRange`;
   `payout` from a second account reverts `OnlyOperator`, and works after `setOperator(<second account>)`.
3. Switch the environment to **Browser Extension** (MetaMask on Sepolia) and deploy with **Value = 0**. The deploying
   account becomes `owner`.
4. Copy the contract address from *Deployed Contracts* (not the account address or the transaction hash), and the
   block number of the deployment transaction from Etherscan.
5. For withdrawals: create a second MetaMask account for the server (the operator) and send it a little Sepolia ETH
   for gas. Call `setOperator(<its address>)`, then `fund` the contract with some Sepolia ETH (Value = 0.2 ether, say).

**Or with Hardhat**: `contracts/scripts/deploy.js` does steps 3–5 and prints the `.env` lines:

```bash
docker run --rm -v "$PWD/contracts:/app" -w /app \
  -e DEPLOYER_PRIVATE_KEY=0x... -e OPERATOR_ADDRESS=0x... -e FUND_ETH=0.2 \
  node:22-alpine sh -c "npm ci && npm run deploy:sepolia"
```

`contracts/NaebkaCashier.abi.json` is the compiled ABI (`npm run abi` regenerates it), for Remix "At Address" or
Etherscan.

### 2. Configure and start

```bash
cp .env.example .env
# deposits:    NAEBKA_ETH_CONTRACT_ADDRESS=0x...  NAEBKA_ETH_DEPLOY_BLOCK=<block>
# withdrawals: NAEBKA_ETH_OPERATOR_KEY=0x<private key of the operator account>
docker compose up --build
```

The operator key must belong to a **Sepolia test account only**. It pays the gas for payouts; the ETH itself comes
from the contract. Never use a key that holds real money. Optional: `NAEBKA_ETH_RPC_URL` (default: the public
`ethereum-sepolia-rpc.publicnode.com`; an Infura or Alchemy Sepolia URL is more reliable),
`NAEBKA_ETH_TOKENS_PER_ETH`, `NAEBKA_ETH_CONFIRMATIONS` (default 3), `NAEBKA_ETH_MAX_FEE_GWEI` (default 50).
If players open the site at an address other than `http://localhost:8080`, set `NAEBKA_ETH_SIWE_DOMAIN` and
`NAEBKA_ETH_SIWE_URI` to match, or MetaMask warns that the sign-in message is for another site.

### 3. Play

Wallet page → **Sepolia test ETH** card:

1. **Connect MetaMask** (switch to Sepolia if asked).
2. **Link this address**: MetaMask asks you to sign a Sign-In with Ethereum message. Signing is free and sends no
   transaction; it proves you hold the key, so nobody can link your address to their account.
3. **Deposit**: approve the transaction. The Etherscan link appears as soon as it is submitted. The core credits the
   tokens once the block is 3 confirmations deep (about a minute).
4. **Withdraw** (needs a verified identity, like every withdrawal): enter an amount in NTK. The tokens are taken at
   once, and the ETH arrives at the linked address within a minute or two. MetaMask doesn't have to be open: the server
   sends the transaction.

How it works:

* `eth/EthDepositPoller` polls `eth_getLogs` for `Deposited` events. It saves the events of a block range and its
  "last processed block" cursor in one database transaction, so after a crash the range is read again and the
  unique (chain, tx, log index) key turns the repeat into a no-op. It deliberately does not use Redis pub/sub,
  which drops messages while the core is down.
* `eth/EthDepositService` credits through `WalletService` with the idempotency key
  `deposit:eth:<chain>:<tx>:<logIndex>`, so the append-only ledger, responsible-gambling limits and the KYC deposit
  cap all apply (the `deposit:` prefix is what the KYC cap counts). A deposit from an address nobody has linked
  waits as `unlinked` and is credited when someone links it. A deposit over a deposit limit or the unverified KYC
  cap, during self-exclusion, or above the max single deposit is `held`. The ETH is already on chain, so it is kept,
  never refused.
* `eth/EthWithdrawalService` takes the tokens with the ledger key `withdrawal:eth:<user>:<Idempotency-Key>` and
  stores a `pending` withdrawal in the same transaction, so a retried request never takes them twice.
* `eth/EthPayoutSender` pays one withdrawal at a time. It first asks the node to estimate `payout()`: if the contract
  would refuse (paused, daily limit, not enough ETH in it, operator not set), the withdrawal waits and shows why. It
  signs an EIP-1559 transaction with the operator key (`eth/EthPayout`), saves it as `sent` with its hash, and only
  then broadcasts it. Mined and 3 blocks deep: `confirmed`. Reverted: `failed` and the tokens are refunded, unless
  `paid(withdrawalId)` on the contract says an earlier transaction paid it. Not mined in 5 minutes: broadcast again.
  Not mined in an hour: `review`.
* Admins see unlinked and held deposits, open withdrawals, the operator's and the contract's balances, and the pause
  state at `GET /api/admin/eth`. `POST /api/admin/eth/deposits/{id}/retry` re-runs a deposit's checks (for example
  after the player is KYC-verified). `POST /api/admin/eth/withdrawals/{id}/retry` sends a withdrawal in review again;
  the contract refuses to pay the same id twice.

Lab-style test (accounts A and B in MetaMask, both with Sepolia ETH; the contract has an operator and some funds):

| Step | Account | Action | Expected |
|---|---|---|---|
| 1 | A | Connect, link, deposit 0.001 ETH | +100 NTK after ~1 min, status `credited` |
| 2 | B | Deposit from Remix without linking | Status `unlinked` (admin view), no tokens |
| 3 | B | Log in as a second user, link B | The waiting deposit is credited at once |
| 4 | A | Deposit 0.00001 ETH | MetaMask/Remix rejects: `AmountOutOfRange` |
| 5 | B | `payout` in Remix | `OnlyOperator` |
| 6 | A | Set a 1 NTK daily deposit limit, deposit 0.001 ETH | Status `held` with the limit reason |
| 7 | A | Link A to the second user too | `ADDRESS_TAKEN` |
| 8 | A | New unverified user (no limits), link A, deposit 0.03 ETH (3,000 NTK) | `held`: over the 2,000 NTK KYC cap; after KYC verification an admin retry credits it |
| 9 | A | Verified user withdraws 100 NTK | −100 NTK at once; `paid` with an Etherscan link after ~1 min; +0.001 ETH in MetaMask |
| 10 | owner | `pause()` in Remix, then A withdraws | Stays `queued` with "The cashier contract is paused"; paid after `unpause()` |
| 11 | A | Unverified user withdraws | `KYC_REQUIRED` |

## Architecture

```mermaid
flowchart LR
  DL[(Deadlock public API)] -->|poll /v1/matches/active| W[Watcher<br/>Python]
  W -->|match events| R[(Redis pub/sub)]
  R --> O[Odds Engine<br/>Python]
  O -->|odds updates| R
  R --> C[Core API<br/>Spring Boot]
  C <--> P[(PostgreSQL<br/>append-only ledger)]
  C -->|ws fan-out| R
  C -->|post-match report| DL
  W -.->|on 429 / down| SB[deadlock-bot<br/>Rust, Steam]
  C -.->|on 429 / down| SB
  SB -->|Steam game coordinator| V[(Valve)]
  B[Browser<br/>SolidJS] -->|pages + REST + WebSocket| C
```

* **Transactional core** (modular monolith): auth, wallet/ledger, responsible gambling, live betting, settlement
  worker, slots, poker, chat, WebSocket hub. Packages only touch money through `WalletService`.
* **Event-driven live data**: the watcher knows nothing about odds or money; the odds engine knows nothing about
  users. Everything Deadlock-specific lives in `live/naebka_live/deadlock_api.py` + `watcher.py`.

### The live-betting loop

1. **Discover**: the watcher keeps up to 8 fresh Normal-mode matches (best rank first), and re-announces them every
   minute so a restarted core picks them up.
2. **Ingest**: each 10 s poll is diffed into `objective.destroyed`, `networth.swing`, `match.ended` or
   `match.snapshot`.
3. **Suspend first**: on a state-changing event the core immediately moves every OPEN market to SUSPENDED.
4. **Reprice**: the odds engine waits a 5 s cooling-off, prices the new state and publishes. The core writes
   `odds_history` and reopens the market (plausibility band 1.01–51.0, otherwise it stays suspended).
5. **Bet**: `POST /api/bets` re-validates after a 1.5 s acceptance delay under a row lock. If the price moved you
   get `409 PRICE_CHANGED` (or the bet takes the better price if you allowed higher odds).
6. **Settle**: when the match ends, the settlement worker fetches `/v1/matches/{id}/metadata`. If it agrees with the
   stream, payouts go to the ledger. On a mismatch or data-quality flag, or if no report arrives within 3 h, the
   match goes to the manual-review queue.
7. **Watchdogs**: no watcher data for 60 s → STALE and suspended. Stale for 20 min → ended and settled from the
   report.

## Live matches and the realtime map

**All live matches** (lobby, below "Bet live"): every match of the in-game Watch tab (up to 200) with each
player's hero, Steam name and rank badge, each team's average rank, souls, the match clock, and filters for region,
mode and player, plus the rank spread. It refreshes every 30 s. Matches you can bet on are marked and open their
betting page; the others open `/live/{matchId}`.

**Realtime map** (match page and `/live/{matchId}`): the minimap with every hero (portrait, team ring, health bar,
respawn timer, a gold dot when the ultimate is ready), the lanes, the objectives with their health, and:

* the **Soul Urn** on the ground or on its carrier, with the pad it has to reach and its value in souls;
* the **Unstable Rift**: a countdown while it appears, then each team's capture progress, a pulsing ring while both
  teams contest it, the heroes on the point and the time before it closes;
* the **neutral camps** with the game's own respawn timers (small, medium and hard camps, and the Sinner's
  Sacrifices with their health while someone hits them), the **Mid-Boss** respawn and the **bridge power-ups**.

Scroll or use +/− to zoom, drag to pan, double-click for the whole map; "Follow" keeps the selected hero in view. A
panel above the tabs sums up the urn, the rift, the Mid-Boss and the camps. The tabs: **events** (kills, purchases,
level-ups, abilities unlocked and upgraded, objectives, Mid-Boss, urn and rift; filter by kind), **stats** (level,
K/D/A, souls, health, rank), **builds** (each hero's four abilities with their points, and items) and **souls** (the
lead over time). Click a hero for a card with its abilities, unspent souls, last hits, denies, damage and items. It
plays about 25 s behind the real game: Valve's broadcast delay (about 21 s) plus a few seconds of smoothing. You can
pause and jump back to live.

Item and objective icons are the game's current art from the [Deadlock Wiki](https://deadlock.wiki), stored as small
WebP files in `frontend/public/icons/`. Refresh them after a patch with `python frontend/scripts/wiki_icons.py` (needs
Pillow). Items the wiki has no icon for keep deadlock-api's.

Who may watch: admins and premium players (`POST /api/admin/users/{id}/premium {"premium": true}`) can watch every
match. Other logged-in players can watch a match once they have at least `LIVE_VIEW_MIN_STAKE_TOKENS` (100) staked on
it. Set it to 0 to open the map to every logged-in player.

How it works:

```mermaid
flowchart LR
  V[(Valve broadcast relay)] -->|HTTP fragments, ~3 s each| B[deadlock-bot<br/>haste parser]
  B -->|live:frame + naebka:live-frames| R[(Redis)]
  R --> W[Watcher] -->|state from frames: odds| R
  R --> C[Core: LiveFrameRelay<br/>+5 s] -->|watch:matchId| UI[Browser map]
  DL[(deadlock-api)] -->|names, ranks, assets| W -->|live:directory| R
```

* **Directory** (`live/naebka_live/directory.py`): after each poll the watcher adds Steam names
  (`/v1/players/steam`) and ranks (`/v1/players/rank`), batched 1000 at a time and cached in Redis (names 24 h,
  ranks 1 h), so a full list costs a few requests an hour. Hero, rank and item images and the map come from
  deadlock-api's assets every 6 h. The core serves them at `GET /api/live/directory`, `/api/live/assets` and
  `/api/live/matches/{id}`.
* **Feeds** (`deadlock-bot/src/feeds.rs`, `src/live.rs`): the bot follows the broadcasts of the watcher's tracked
  matches and of any match a viewer has open (up to `DEADLOCK_BOT_MAX_FEEDS`, 12), one parser thread each. Broadcast
  URLs come from deadlock-api's public list, or from spectating with the bot (one per 5 minutes). Every frame (twice
  a second) goes to Redis.
* **Odds from the broadcast**: for tracked matches with a feed, the watcher uses the broadcast state instead of the
  live list, which is 2–4 minutes old. That includes Valve's own objective bitmasks, so the numbers are on the same
  scale as the list's. Objectives and souls swings therefore suspend markets within about 2 s of the broadcast
  showing them, not minutes later.
* **Courtsiding defence**: the core holds every frame for `LIVE_VIEW_DELAY_SECONDS` (5) before sending it to viewers,
  so markets are suspended before anyone watching sees the event that suspended them.

## Steam bot fallback

deadlock-api limits each IP. The live match list allows 100 requests/s (and is cached for 120 s), but a match
result that has to come fresh from Steam, which is the case right after a match ends, allows only **3 requests per
hour**. Settlement asks for every ended match, so it used to hit "429 Too Many Requests" and stall.

`deadlock-bot/` is the team's own Steam bot. In `serve` mode it stays logged in to Steam and answers
`GET /v1/matches/active` and `GET /v1/matches/{id}/metadata` with the same JSON as deadlock-api, so the site only
needs a second address:

* **Settlement** (`live/FallbackReportSource.java`): deadlock-api first. On 429/503 its breaker opens for as long as
  `Retry-After` says (60 s without one), and the bot is asked instead. "Not processed yet" (404) from the API is
  final for that attempt, so the bot's smaller budget isn't spent. When both are down, settlement waits for the
  sooner of the two `Retry-After`s instead of a fixed minute.
* **Watcher** (`live/naebka_live/deadlock_api.py`): the same order for the live list. The bot can't look up one
  player's match (`?account_id=`), so while only the bot answers, a match that drops out of the list is called
  ended after 12 missing polls instead of 3.
* **Admin dashboard**: shows both breakers and whether the watcher is on `deadlock-api` or `deadlock-bot`.

The bot keeps its own waits so the Steam account doesn't look like a bot hammering Valve: at most one live list and
one match result per minute and one spectate per 5 minutes, with answers cached. Over that it answers `429` with
`Retry-After`, like deadlock-api.

Run it (needs a separate Steam account with Deadlock access; see [deadlock-bot/README.md](deadlock-bot/README.md)):

```bash
docker compose --profile bot up --build -d
docker compose run --rm deadlock-bot login --username <bot steam login>   # once: password + Steam Guard
```

The login token is kept in the `botdata` volume. Without the `bot` profile everything works as before: requests to
the bot fail fast and settlement waits for deadlock-api.

## KYC

Hybrid identity verification (Risk #5, "AML/KYC program absent"): automatic rules decide the clear cases, and
anything ambiguous goes to a person.

1. The player submits name, document type, number and expiry (`POST /api/kyc/submissions`, page `/verification`).
   Date of birth and country aren't asked again: they come from the profile given at registration. The player can
   correct them on the same page (`PUT /api/auth/me`, same 18+ / licensed-country rules). Every change is kept in
   `profile_changes`. A change is refused while a review is pending, and it ends an existing verification.
2. `RuleBasedKycProvider` runs the checks. It sits behind the `KycProvider` interface, so a real vendor could be
   swapped in later (Strategy pattern).

   | Check | If it fails |
   |---|---|
   | Age ≥ 18, issuing country licensed, document not expired | **FAIL**: auto-rejected, the player can fix it and resubmit |
   | Document number check digit (ICAO 9303: weights 7-3-1, mod 10) | **FAIL** |
   | Date of birth or country changed in the last 30 days | **REVIEW**: goes to the admin KYC queue |
   | Document already used by another account | **REVIEW** |

3. Any FAIL → `REJECTED`; otherwise any REVIEW → `PENDING` (admin approves or rejects at `/admin`, which is
   written to `admin_audit_log`); otherwise → `VERIFIED` automatically.

**Tiered limits** until `VERIFIED`: withdrawals return `403 KYC_REQUIRED`, and lifetime deposits (the signup bonus
doesn't count) are capped at `naebka.kyc.unverified-deposit-cap-tokens` (2,000 NTK).

**Data minimisation:** the document number is never stored. Only the last 4 characters and an HMAC (for
duplicate detection) are kept. On the form, **Use a test number** generates a number with a valid check digit, so
the demo never needs a real document.

Licensed countries (`naebka.registration.licensed-countries`): United Kingdom, Malta, Sweden, Denmark, Czech
Republic, Netherlands, Croatia, Estonia, Italy, Latvia, Switzerland, Romania, Spain, Lithuania, North Macedonia,
Germany, Hungary, Montenegro, Slovenia, Portugal, Belgium, Ireland, Bulgaria, Greece, Serbia, Slovakia.

## Sound and music

Every button, link and tab clicks, and the games have their own sounds: the slot reels spin and land one by one, wins
chime (louder for big wins, rising with each win in a row), poker cards deal and chips clack, and a bell rings on your
turn. A live bet settling plays a win or loss cue on whatever page you're on. There are three **sound packs**:

* **Deadlock**: brass and clockwork (a typewriter-key click, a clock tick, a ratchet for the reels), plus the game's
  own stingers for the big moments: "First Blood" on the first win of a visit, the rising **killstreak** stingers for
  wins in a row, "Urn Arrived" for free spins (the slot's scatter is the Soul Urn), "Rift Announced" for the rift bonus,
  "Rift Secured" for a big win, "Victory" for the jackpot, and the Hidden King's or the Archmother's intro when you pick
  their theme.
* **Arcade**: bright square-wave chimes and coins, like a fruit machine.
* **Soft**: quiet, rounded tones.

The effects are synthesized in the browser with the Web Audio API (`frontend/src/lib/soundPacks.ts`), so they need no
files and play without delay. **Music** is Deadlock's soundtrack from the [Deadlock Wiki](https://deadlock.wiki/Music),
in stations: **Lounge** (the Baroness Hotel's records, the Curiosity Shop, the Greenhouse Waltz, Rem's record),
**Hideout** (the trip-hop title theme), **Gothic** (the original, darker score) and **Rift Fight** (battle loops; can be
picked, isn't given at random). Tracks cross-fade, short loops repeat, and the music ducks under stingers. Every
track is evened out to the same loudness (the wiki's files differ by up to 25 dB), and every pack plays each event at
the same level (`LEVELS` in `soundPacks.ts`), so in the taste test nothing wins just by being louder.

* **Controls:** the speaker button in the header (or the **M** key) mutes everything; *Customize > Sound* has the
  station, the pack (tap one to hear it), and on/off and volume for each. Settings are kept in the browser.
* **Defaults:** music on at 50%, effects at 70% (`AUDIO_DEFAULTS` in `frontend/src/lib/audio.ts`). Browsers only allow
  sound after the first click or key press, so nothing plays before that. Music pauses while the tab is hidden.
* **Silencing a button:** add `data-sound="none"` (or an event name, like `data-sound="bet"`) to it or a container.
* **The music is in the repository** (`frontend/public/music`, 36 files, ~37 MB) and built into the core image, so
  every checkout, build and server has it with nothing to download. `frontend/scripts/wiki_music.py` (standard
  library only) fetched it from the Deadlock Wiki; run it again only to add or refresh tracks. `/music/manifest.json`
  lists what a server has, and the site only offers that. The audio is Valve's: fine in this private repository for a
  class project, but take it out of git before the repository is ever made public.

### No music?

*Customize > Sound* says "This server has no music files yet", or `/music/manifest.json` lists fewer than 36 files:

1. **Rebuild the image.** `docker compose up` alone keeps running the old image: `docker compose up --build -d`.
   The build prints `wiki_music: 36/36 files`.
2. **Check the files are there**: `git status frontend/public/music` (restore them with
   `git checkout -- frontend/public/music`). If any are missing, the build tries the wiki and, if that fails too,
   stops and says what to do. `NAEBKA_MUSIC=skip` in `.env` builds with what's there without asking the wiki.
3. **With `vp dev`** (no Docker) the files are served from `frontend/public/music` directly; just reload.

## A/B tests and feedback

With about a hundred visitors who aren't paid to answer, a classic A/B test (each visitor gets one version, compare
the groups) can only spot huge differences: telling 10% from 15% takes ~700 people per version. So the site combines
three kinds of evidence; the reasoning, the numbers and a **test-day checklist** are in
[docs/ab-testing.md](docs/ab-testing.md).

1. **Taste test** (the main evidence): a small card asks "which do you like more?" with two versions side by side,
   one question each for the theme, the music, the sound effects and the slot symbols. People try both (the page
   switches to it, or they listen), pick one and keep it, so answering is its own reward; about half a minute. Pairs
   and sides are random, both versions must be tried before picking, and every answer is sent at once. A first-visit
   card invites people after a few seconds of use; it is also under *Customize* and in the footer ("Pick your style").
2. **Random assignment** (supporting): every visitor still gets one version of each experiment at random and can
   switch under *Customize*. Each experiment is judged on one number chosen in advance, e.g. how many people turned the
   music off.
3. **One-tap rating**: five faces at the end of the taste test, or once after a couple of minutes of use, then optional
   reason chips ("Love the music", "Hard to read"...) and a comment. The **Feedback** button in the corner stays for
   bugs and longer notes (docked, no overlay, the draft survives page changes). Prompts never appear on forms, never two
   at once, and at most once per visitor.

| Experiment | Versions (first = control) | Primary metric | Taste test |
|---|---|---|---|
| `theme` | Hidden King (amber), Archmother (sapphire), Deadlock (sewer green); Classic (the old gold look) can be picked but isn't given at random | changed by hand (lower is better) | yes |
| `music` | Lounge, Hideout, Gothic; Rift Fight can be picked | turned the music off | yes |
| `sfx_pack` | Deadlock, Arcade, Soft | turned the sounds off | yes |
| `slot_icons` | Deadlock items, Classic fruit | changed by hand | yes |
| `join_cta` | "Join", "Get 1,000 free NTK" (not switchable) | registered (higher is better) | no |

- **Results:** `/admin` > *Recommended combination* (each experiment's leader and how sure we are: clear, likely, too
  close to call), *Taste test* (a Bradley-Terry ranking from all head-to-heads, each version's chance of being the
  favourite, win rates with 95% ranges, and checks that people tried both and didn't just pick a side), *Between
  visitors* (by the version people were first given, with each version's chance of being best on the primary metric)
  and *Feedback* (with the most common reasons). Each card exports CSV. The statistics are in
  `frontend/src/lib/stats.ts` (unit-tested).
- **Where:** experiments, their primary metrics and taste-test questions are defined in
  `frontend/src/lib/experiments.ts` (with how to add one). The core (`core/.../ab/AbController.java`, migrations
  `V8__experiments.sql` and `V9__taste_test.sql`) stores what visitors were given and are on now, their switches (by
  hand or from the taste test), their goals (registered, bet placed, spun slots, sat at poker, music off, sounds off),
  their taste-test answers and their feedback. The public endpoints are rate-limited per visitor, with a looser limit
  per address, so a classroom on one network isn't throttled as one person.
- **Feedback file:** every rating, reason and comment is also appended to `data/feedback.jsonl` on the machine running
  Naebka (one JSON object per line; `/opt/naebka/data` on the server, see [deploy/README.md](deploy/README.md)). It is
  a second copy for safety and for reading without the dashboard; the database stays the main one. Set by
  `NAEBKA_FEEDBACK_FILE` in both Compose files; empty turns it off.
- **Testing a version:** open the site with `?ab=theme:archmother,music:gothic` to force versions in that tab (`?ab=`
  clears it). Forced visits are not counted and get no prompts, so Lighthouse runs and QA don't skew the results:
  `npx lighthouse "http://localhost:8080/?ab=theme:archmother" --view`.
- **Deadlock style:** the three Deadlock themes share a calm slate base modelled on
  [thedeadlockobservatory.com](https://thedeadlockobservatory.com/) (solid panels, soft text, one accent) and switch on
  the Deadlock look: the theme's emblem (its Patron, or the game's eye-and-wheel icon from Steam) drifting slowly
  across the background, sharper panels, condensed uppercase headings and buttons, and main buttons whose plate
  ticks right → centre → left like the game's (1.5°, 0.4 s per step). Deadlock's UI fonts (Valve Pulp, Retail) are Valve's and can't be
  shipped, so they're used only if installed on the visitor's computer; everyone else gets the bundled
  [Big Shoulders Display](https://fonts.google.com/specimen/Big+Shoulders+Display) (OFL). With a licensed copy of a
  game font, add an `@font-face` named `Deadlock UI` in `frontend/src/styles.css` and it is used for everyone.
  Animations stop for people who ask their system for reduced motion.
- **Logged-in players** keep their versions across devices: after login the site takes over the visitor id and choices
  the account had before.

## Tests

```bash
# Java: 78 unit tests (poker rules, hand evaluator, side pots, slot RTP simulation, provable fairness, money, KYC rules,
# deadlock-api -> Steam bot fallback, Ethereum signatures, deposit-log parsing, payout encoding and signing)
cd core && mvn test
# + 66 integration tests on real Postgres/Redis containers (Testcontainers; needs Docker)
cd core && mvn -Pit test
# Coverage (JaCoCo) is written by both commands: core/target/site/jacoco/index.html

# Python: 36 tests, mypy --strict
cd live && python -m venv .venv && .venv/Scripts/pip install -e ".[dev]"   # bin/ on Linux/macOS
.venv/Scripts/python -m pytest && .venv/Scripts/python -m mypy naebka_live tests
.venv/Scripts/python -m pytest --cov=naebka_live --cov-report=html   # coverage: live/htmlcov/index.html

# Frontend (no local Node needed): types, lint, 17 unit tests (the A/B statistics), build
docker run --rm -v "$PWD/frontend:/app" -w /app node:22-alpine sh -c "npm install && npx tsc --noEmit && npx vp lint src && npx vp test run && npm run build"

# Steam bot: 35 unit tests (needs Rust and protoc, see deadlock-bot/README.md)
cd deadlock-bot && cargo test

# Cashier contract: 17 Hardhat tests (no local Node needed)
docker run --rm -v "$PWD/contracts:/app" -w /app node:22-alpine sh -c "npm ci && npx hardhat test"
```

What the integration tests prove (Definition of Done: "end-to-end simulated match flows: place, suspend, reprice,
settle" via the scripted `MatchSimulator`):

* **Full match flow**: place, then suspend on an event, then `MARKET_SUSPENDED`, then reprice, then `PRICE_CHANGED`,
  then end, then auto-settle and pay out.
* Stream/report disagreement → `REVIEW`; void → stakes refunded.
* 40 concurrent debits on one wallet → exactly 20 succeed, balance never negative, ledger sum = balance.
* Idempotency keys move money once; the ledger rejects `UPDATE`/`DELETE`.
* KYC: a clean submission is auto-verified, a bad check digit is auto-rejected and can be resubmitted, a recent
  profile change or a reused document goes to review, admin decisions are audited, profile edits are blocked during
  review and end a verification, unverified users can't withdraw and hit the deposit cap.
* Withdrawals to MetaMask (against a fake chain): signed by the operator, sent one at a time, confirmed after 3 blocks;
  a reverted payout is refunded once, but not when the contract says it was already paid; a paused contract makes
  it wait; the same Idempotency-Key never takes tokens twice; KYC, a linked address and the contract's limits are
  required.
* Realtime map: only admins, premium players and players with a big enough bet may watch; rosters are stored with
  the match and shown with names and ranks; the directory links matches that can be bet on.
* WebSocket (a real client against the server, fan-out through Redis): auth and presence, which topics may be
  subscribed, replay of missed messages with `lastSeq`, delivery only after commit, the realtime-map permission.
* Chat: messages stored and pushed live on `chat:{room}`, login needed to post, 500-character limit, rate limit.
* HTTP: RFC 7807 errors, logout revokes the JWT, slot spin is verifiable after seed rotation, poker buy-in/cash-out.

## Where each design document lives in the code

| Spec | Implementation |
|---|---|
| DB design: 24 tables, 3NF, CHECKs, partial indexes | `core/src/main/resources/db/migration/V1__schema.sql` (extra tables are marked `[ADDED]` with the doc that requires them) |
| Append-only ledger, atomic conditional debit (LLD §2.1, Risk #7) | `wallet/WalletService.java`: DB triggers forbid ledger edits |
| LLD exception hierarchy and resolutions | `common/Exceptions.java`, `common/ErrorCode.java` (HTTP + WS codes 1001–1005), `common/TxRetry.java` (100/300/500 ms retry → 503) |
| RFC 7807 errors, Idempotency-Key, cursor pagination | `common/GlobalExceptionHandler.java`, `common/Cursor.java` |
| JWT (never in URLs), bcrypt, sessions, lockout (Risk #2) | `auth/*`: the WebSocket authenticates with its first message, not a query string |
| Suspend-then-reprice, odds_history, plausibility watchdog | `live/MatchService.java`, `live/BetService.java` |
| Settlement reconciliation + manual review | `live/SettlementService.java`, `live/FallbackReportSource.java` + `live/DeadlockReportClient.java` (circuit breakers, Steam bot fallback), `/admin` |
| BettingEngine UML | `live/*`; markets are DB-driven (match winner, duration over/under 30:00) |
| Slot machine UML (SlotMachine, Reel, Paytable, Payline, ProvablyFairRNG, BonusGame, JackpotPool…) | `slots/*` |
| Poker UML (PokerTable, Player, Deck, HandEvaluator, PotManager, Pot…) | `poker/*`: one actor thread per table |
| Hole-card masking, same-IP restriction (LLD §2.1) | `PokerTable.publicState()` / `privateState()`, `PokerService.sit()` |
| WebSocket `{topic, seq, ts, data}` with `lastSeq` resume | `ws/WsHub.java`, `ws/NaebkaWebSocketHandler.java`, `frontend/src/lib/ws.ts` |
| Responsible gambling (Risk #4) | `wallet/ResponsibleGamingService.java`: deposit/wager/loss limits, 24 h cooling-off on increases, self-exclusion |
| KYC: hybrid auto + manual verification, tiered limits (Risk #5) | `kyc/*`, `db/migration/V3__kyc.sql`, `V4__profile_changes.sql`, `frontend/src/pages/Verification.tsx`, KYC queue in `/admin` |
| MetaMask + Sepolia deposits and withdrawals (course web3 lab) | `contracts/` (contract, Hardhat tests, deploy script), `eth/*`, `db/migration/V5__eth.sql`, `V6__eth_withdrawals.sql`, `frontend/src/lib/eth.ts`, `frontend/src/components/EthWallet.tsx` |
| CURRENCY_MODE compliance gate (Risk #13) | `config/CurrencyModeGuard.java`: REAL_MONEY refuses to start without the license sign-off file |
| Frontend stack (Vite+, SolidJS, TS, Tailwind, TanStack, openapi-typescript, component registry) | `frontend/`; API types generated into `src/api/schema.d.ts` (`npm run gen:api`), shared components in `src/components/ui.tsx` |

## Decisions and deviations from the documents

Where the documents disagreed or left things open, this is what was built and why.

| Topic | Documents say | Built | Why |
|---|---|---|---|
| Frontend hosting | Architecture: Docker Compose behind an Nginx reverse proxy | The core serves the built frontend (`config/FrontendConfig.java`); the Docker image builds `frontend/` | One container fewer and no proxy config; HTTPS for the domain is still a reverse proxy on the server |
| Odds model | LLD: pari-mutuel; Technical Design: heuristic fixed odds | Heuristic fixed odds with suspend-then-reprice | Matches the architecture and risk docs (courtsiding defense needs fixed prices) |
| Payments | Architecture: PSP webhooks; DB: Bitcoin; DoD: play money | Play-money deposit/withdraw endpoints, plus Sepolia test-ETH deposits and withdrawals through MetaMask (`eth/*`, `contracts/`); `btc_payments` table exists but is unused | No licence; the DoD milestone is play money, and Sepolia ETH has no value |
| Login | Steam OpenID + email/password | Username/password + JWT; `/api/auth/steam` returns 501 | Steam needs a public return URL; insider-betting check (`BETTOR_IS_PARTICIPANT`) depends on it |
| Games | CS2 + Deadlock | Deadlock only; `cs2` row exists, inactive | Only Deadlock has a data source |
| Watcher fleet | Supervisor + many watchers | One watcher process + core watchdogs (STALE, heartbeat) | MVP scale (≤ 8 matches); same event contract, so it can be split later |
| Slots / poker transport | LLD: WebSocket controllers | Slots over REST (a spin is one atomic request); poker actions over WebSocket (REST also available) | Simpler, same guarantees |
| Money type | LLD: `BigDecimal` | `long` minor units (DB design: "minor units") | Exact integer arithmetic; API still speaks decimal tokens |
| Settlement when stream lost the winner | Strict agreement required | Settles from the official report alone if the stream has no winner; any *disagreement* still goes to review | The public API usually drops a match before showing its winner; strict mode would send almost every match to review |
| Accept higher odds | – | Opt-in on the bet slip (default on) | Live prices drift every few seconds; price drops still need reconfirmation |
| Frontend tests | – | Type-check + Vite+ lint + unit tests for the A/B statistics; no component tests yet | Time; backend logic is covered |

## Known gaps (not built)

* Real-money rails (PSP, real KYC vendor and document-photo checks, AML transaction monitoring, geo-IP checks,
  withdrawal review queue) — the compliance gate blocks REAL_MONEY.
* Steam OpenID, 2FA, insider-betting cross-check.
* Reality-check reminders, first-withdrawal delay, chargeback / negative-balance policy (Risk #12).
* Kubernetes deployment, load tests, SonarQube/CI pipeline.
* Poker: no rebuy/top-up (leave and sit again), no run-it-twice; slot "SlotEventListener" is not used.

Merge PR #24.
DNS: in the naebka.win zone, add an A record poker → 37.27.152.78. If the domain is on Cloudflare, set it to DNS only (grey cloud).
Admin login for /admin: username admin, password VpROdtQLmAGQ0Ykj7xQremyC. Change it in /opt/naebka/.env if you like, then restart.
Root password: it was shared in this chat, so change it with passwd on the server. Password login is still on (fail2ban only limits it). Once you've confirmed SSH-key login works for you, consider turning password login off.