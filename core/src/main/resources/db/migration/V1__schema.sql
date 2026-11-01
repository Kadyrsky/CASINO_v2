-- Naebka schema — implements "Online Casino Database Design" (6 modules, 24 tables, 3NF).
-- Money is always bigint minor units (currencies.decimals). Odds are numeric > 1.
-- Additions beyond the 24 design tables are marked [ADDED] with the document that requires them.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =====================================================================
-- Users & safety
-- =====================================================================
CREATE TABLE users (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    username           text NOT NULL,
    email              text NOT NULL,
    password_hash      text NOT NULL,
    status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked')),
    -- [ADDED] role for the admin manual-review queue (Technical Design: settlement reconciliation)
    role               text NOT NULL DEFAULT 'PLAYER' CHECK (role IN ('PLAYER', 'ADMIN')),
    -- [ADDED] profile validation "age and country" (System Architecture Design: Core REST API)
    date_of_birth      date NOT NULL,
    country            char(2) NOT NULL,
    -- [ADDED] failed-login lockout (Risk #2)
    failed_login_count int NOT NULL DEFAULT 0,
    locked_until       timestamptz,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_username_ci ON users (lower(username));
CREATE UNIQUE INDEX users_email_ci ON users (lower(email));

CREATE TABLE sessions (
    id          uuid PRIMARY KEY,
    user_id     uuid NOT NULL REFERENCES users (id),
    token_hash  text NOT NULL,
    ip_address  text,
    user_agent  text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL,
    revoked_at  timestamptz
);
CREATE INDEX sessions_user ON sessions (user_id, created_at DESC);

CREATE TABLE currencies (
    id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code     text NOT NULL UNIQUE,
    name     text NOT NULL,
    decimals int NOT NULL CHECK (decimals BETWEEN 0 AND 18)
);

CREATE TABLE user_limits (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        uuid NOT NULL REFERENCES users (id),
    currency_id    uuid NOT NULL REFERENCES currencies (id),
    limit_type     text NOT NULL CHECK (limit_type IN ('deposit', 'loss', 'wager')),
    period         text NOT NULL CHECK (period IN ('daily', 'weekly', 'monthly')),
    amount         bigint NOT NULL CHECK (amount > 0),
    effective_from timestamptz NOT NULL DEFAULT now(),
    created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX user_limits_user ON user_limits (user_id, limit_type, period, effective_from DESC);

CREATE TABLE self_exclusions (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid NOT NULL REFERENCES users (id),
    starts_at  timestamptz NOT NULL DEFAULT now(),
    ends_at    timestamptz, -- NULL = permanent
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (ends_at IS NULL OR ends_at > starts_at)
);
CREATE INDEX self_exclusions_user ON self_exclusions (user_id);

-- =====================================================================
-- Currency & wallet (append-only ledger)
-- =====================================================================
CREATE TABLE wallets (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid NOT NULL REFERENCES users (id),
    currency_id uuid NOT NULL REFERENCES currencies (id),
    balance     bigint NOT NULL DEFAULT 0 CHECK (balance >= 0),
    -- [ADDED] optimistic version counter (Risk #7: "wallets.version")
    version     bigint NOT NULL DEFAULT 0,
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, currency_id)
);

CREATE TABLE btc_payments (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id   uuid NOT NULL REFERENCES wallets (id),
    direction   text NOT NULL CHECK (direction IN ('deposit', 'withdrawal')),
    address     text NOT NULL,
    txid        text UNIQUE,
    amount_sats bigint NOT NULL CHECK (amount_sats > 0),
    status      text NOT NULL CHECK (status IN ('pending', 'confirmed', 'failed')),
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX btc_payments_pending ON btc_payments (created_at) WHERE status = 'pending';

-- =====================================================================
-- Live betting
-- =====================================================================
CREATE TABLE games (
    id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code      text NOT NULL UNIQUE,
    name      text NOT NULL,
    is_active boolean NOT NULL DEFAULT true
);

CREATE TABLE teams (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    game_id     uuid NOT NULL REFERENCES games (id),
    external_id text NOT NULL,
    name        text NOT NULL,
    UNIQUE (game_id, external_id)
);

CREATE TABLE matches (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    game_id            uuid NOT NULL REFERENCES games (id),
    external_id        text NOT NULL,
    status             text NOT NULL CHECK (status IN
                        ('LIVE', 'STALE', 'ENDED', 'REVIEW', 'SETTLED', 'VOID')),
    starts_at          timestamptz NOT NULL,
    created_at         timestamptz NOT NULL DEFAULT now(),
    -- [ADDED] normalized match_state from the watcher (Technical Design: Watcher Fleet module)
    state              jsonb NOT NULL DEFAULT '{}'::jsonb,
    last_event_at      timestamptz NOT NULL DEFAULT now(),
    ended_at           timestamptz,
    stream_winner_side int CHECK (stream_winner_side IN (1, 2)),
    review_reason      text,
    settle_attempts    int NOT NULL DEFAULT 0,
    next_settle_at     timestamptz,
    settled_at         timestamptz,
    UNIQUE (game_id, external_id)
);
CREATE INDEX matches_open ON matches (starts_at DESC) WHERE status IN ('LIVE', 'STALE');
CREATE INDEX matches_to_settle ON matches (next_settle_at) WHERE status = 'ENDED';

CREATE TABLE match_participants (
    match_id  uuid NOT NULL REFERENCES matches (id),
    team_id   uuid NOT NULL REFERENCES teams (id),
    side      int NOT NULL CHECK (side IN (1, 2)),
    is_winner boolean,
    PRIMARY KEY (match_id, team_id),
    UNIQUE (match_id, side)
);

CREATE TABLE markets (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    match_id       uuid NOT NULL REFERENCES matches (id),
    market_type    text NOT NULL CHECK (market_type IN ('match_winner', 'duration_over_under')),
    name           text NOT NULL,
    status         text NOT NULL CHECK (status IN ('OPEN', 'SUSPENDED', 'CLOSED', 'SETTLED', 'VOID')),
    -- [ADDED] suspend-then-reprice bookkeeping (Technical Design: algorithm designs)
    line           numeric(10, 1),
    suspended_at   timestamptz,
    suspend_reason text,
    price_version  bigint NOT NULL DEFAULT 0,
    UNIQUE (match_id, market_type)
);
CREATE INDEX markets_match ON markets (match_id);

CREATE TABLE selections (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    market_id   uuid NOT NULL REFERENCES markets (id),
    -- [ADDED] stable machine key of the outcome: side1/side2/over/under
    outcome_key text NOT NULL,
    name        text NOT NULL,
    odds        numeric(8, 2) CHECK (odds > 1),
    result      text CHECK (result IN ('WON', 'LOST', 'VOID')),
    UNIQUE (market_id, outcome_key)
);
CREATE INDEX selections_market ON selections (market_id);

CREATE TABLE odds_history (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    selection_id uuid NOT NULL REFERENCES selections (id),
    odds         numeric(8, 2) NOT NULL CHECK (odds > 1),
    -- [ADDED] which event caused the reprice (dispute resolution, Risk #11)
    reason       text,
    recorded_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX odds_history_selection ON odds_history (selection_id, recorded_at DESC);

CREATE TABLE bets (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id         uuid NOT NULL REFERENCES wallets (id),
    selection_id      uuid NOT NULL REFERENCES selections (id),
    stake             bigint NOT NULL CHECK (stake > 0),
    odds_at_placement numeric(8, 2) NOT NULL CHECK (odds_at_placement > 1),
    status            text NOT NULL CHECK (status IN ('PENDING', 'WON', 'LOST', 'VOID')),
    payout            bigint NOT NULL DEFAULT 0 CHECK (payout >= 0),
    -- [ADDED] Idempotency-Key of the POST /api/bets request
    idempotency_key   text NOT NULL UNIQUE,
    placed_at         timestamptz NOT NULL DEFAULT now(),
    settled_at        timestamptz,
    -- "a bet is settled exactly when it is no longer pending"
    CHECK ((status = 'PENDING') = (settled_at IS NULL))
);
CREATE INDEX bets_wallet ON bets (wallet_id, placed_at DESC, id DESC);
CREATE INDEX bets_pending_selection ON bets (selection_id) WHERE status = 'PENDING';

-- [ADDED] append-only normalized event log (Technical Design: "append-only match_events log")
CREATE TABLE match_events (
    id          bigserial PRIMARY KEY,
    match_id    uuid NOT NULL REFERENCES matches (id),
    event_id    text NOT NULL UNIQUE,
    type        text NOT NULL,
    payload     jsonb NOT NULL,
    occurred_at timestamptz NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX match_events_match ON match_events (match_id, id DESC);

-- =====================================================================
-- Slots
-- =====================================================================
CREATE TABLE slot_games (
    id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL UNIQUE
);

CREATE TABLE slot_rounds (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    game_id     uuid NOT NULL REFERENCES slot_games (id),
    wallet_id   uuid NOT NULL REFERENCES wallets (id),
    bet_amount  bigint NOT NULL CHECK (bet_amount >= 0), -- 0 for free spins
    win_amount  bigint NOT NULL CHECK (win_amount >= 0),
    result_data jsonb NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX slot_rounds_wallet ON slot_rounds (wallet_id, created_at DESC, id DESC);

-- [ADDED] provably-fair seed pairs (LLD: ProvablyFairRNG serverSeed/clientSeed/nonce)
CREATE TABLE fairness_seeds (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          uuid NOT NULL REFERENCES users (id),
    server_seed      text NOT NULL,
    server_seed_hash text NOT NULL,
    client_seed      text NOT NULL,
    nonce            bigint NOT NULL DEFAULT 0,
    active           boolean NOT NULL DEFAULT true,
    created_at       timestamptz NOT NULL DEFAULT now(),
    revealed_at      timestamptz
);
CREATE UNIQUE INDEX fairness_seeds_active ON fairness_seeds (user_id) WHERE active;

-- [ADDED] per-player slot state machine (LLD: SlotState IDLE/SPINNING/FREE_SPINNING/BONUS_GAME)
CREATE TABLE slot_sessions (
    user_id              uuid NOT NULL REFERENCES users (id),
    game_id              uuid NOT NULL REFERENCES slot_games (id),
    state                text NOT NULL CHECK (state IN ('IDLE', 'SPINNING', 'FREE_SPINNING', 'BONUS_GAME')),
    free_spins_remaining int NOT NULL DEFAULT 0 CHECK (free_spins_remaining >= 0),
    free_spin_bet        bigint NOT NULL DEFAULT 0,
    bonus_state          jsonb,
    last_round_id        uuid REFERENCES slot_rounds (id),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, game_id)
);

-- [ADDED] progressive jackpot (LLD: JackpotPool)
CREATE TABLE jackpot_pools (
    game_id       uuid PRIMARY KEY REFERENCES slot_games (id),
    amount        bigint NOT NULL CHECK (amount >= 0),
    seed_amount   bigint NOT NULL,
    contribution_bp int NOT NULL, -- basis points of each bet
    updated_at    timestamptz NOT NULL DEFAULT now()
);

-- =====================================================================
-- Poker
-- =====================================================================
CREATE TABLE poker_tables (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text NOT NULL,
    currency_id uuid NOT NULL REFERENCES currencies (id),
    small_blind bigint NOT NULL CHECK (small_blind > 0),
    big_blind   bigint NOT NULL CHECK (big_blind >= small_blind),
    max_seats   int NOT NULL CHECK (max_seats BETWEEN 2 AND 10),
    status      text NOT NULL CHECK (status IN ('OPEN', 'CLOSED'))
);

CREATE TABLE poker_seats (
    id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    table_id uuid NOT NULL REFERENCES poker_tables (id),
    user_id  uuid NOT NULL REFERENCES users (id),
    seat_no  int NOT NULL CHECK (seat_no >= 0),
    stack    bigint NOT NULL CHECK (stack >= 0),
    UNIQUE (table_id, seat_no),
    UNIQUE (table_id, user_id)
);

CREATE TABLE poker_hands (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    table_id   uuid NOT NULL REFERENCES poker_tables (id),
    rake       bigint NOT NULL DEFAULT 0 CHECK (rake >= 0),
    -- [ADDED] board cards for hand history
    board      text,
    started_at timestamptz NOT NULL,
    ended_at   timestamptz
);
CREATE INDEX poker_hands_table ON poker_hands (table_id, started_at DESC);

CREATE TABLE poker_hand_players (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    hand_id    uuid NOT NULL REFERENCES poker_hands (id),
    user_id    uuid NOT NULL REFERENCES users (id),
    bet_total  bigint NOT NULL CHECK (bet_total >= 0),
    win_amount bigint NOT NULL CHECK (win_amount >= 0),
    -- [ADDED] shown cards / hand rank at showdown
    hole_cards text,
    hand_rank  text
);
CREATE INDEX poker_hand_players_user ON poker_hand_players (user_id, hand_id);

-- =====================================================================
-- Ledger rows (after all source tables exist)
-- =====================================================================
CREATE TABLE transactions (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id       uuid NOT NULL REFERENCES wallets (id),
    type            text NOT NULL CHECK (type IN (
                        'DEPOSIT', 'WITHDRAWAL',
                        'BET_STAKE', 'BET_PAYOUT', 'BET_REFUND',
                        'SLOT_BET', 'SLOT_WIN', 'JACKPOT_WIN',
                        'POKER_BUY_IN', 'POKER_CASH_OUT',
                        'ADJUSTMENT')),
    amount          bigint NOT NULL CHECK (amount <> 0), -- signed: negative = debit
    balance_after   bigint NOT NULL CHECK (balance_after >= 0),
    bet_id          uuid REFERENCES bets (id),
    slot_round_id   uuid REFERENCES slot_rounds (id),
    poker_hand_id   uuid REFERENCES poker_hands (id),
    btc_payment_id  uuid REFERENCES btc_payments (id),
    idempotency_key text NOT NULL UNIQUE,
    created_at      timestamptz NOT NULL DEFAULT now(),
    -- "A ledger row has at most one source"
    CHECK (num_nonnulls(bet_id, slot_round_id, poker_hand_id, btc_payment_id) <= 1)
);
CREATE INDEX transactions_wallet ON transactions (wallet_id, created_at DESC, id DESC);
CREATE INDEX transactions_bet ON transactions (bet_id) WHERE bet_id IS NOT NULL;

-- The ledger is append-only: corrections are new ADJUSTMENT rows, never edits (Risk #7).
CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END $$;
CREATE TRIGGER transactions_append_only BEFORE UPDATE OR DELETE ON transactions
    FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER odds_history_append_only BEFORE UPDATE OR DELETE ON odds_history
    FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER match_events_append_only BEFORE UPDATE OR DELETE ON match_events
    FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- =====================================================================
-- Chat
-- =====================================================================
CREATE TABLE chat_rooms (
    id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    match_id uuid UNIQUE REFERENCES matches (id), -- NULL = global room
    name     text NOT NULL
);

CREATE TABLE chat_messages (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id    uuid NOT NULL REFERENCES chat_rooms (id),
    user_id    uuid NOT NULL REFERENCES users (id),
    message    text NOT NULL CHECK (length(message) BETWEEN 1 AND 500),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chat_messages_room ON chat_messages (room_id, created_at DESC);

-- [ADDED] immutable audit log of admin actions (Risk #15: "immutable audit log (J5)")
CREATE TABLE admin_audit_log (
    id         bigserial PRIMARY KEY,
    admin_id   uuid NOT NULL REFERENCES users (id),
    action     text NOT NULL,
    target     text NOT NULL,
    details    jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER admin_audit_log_append_only BEFORE UPDATE OR DELETE ON admin_audit_log
    FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
