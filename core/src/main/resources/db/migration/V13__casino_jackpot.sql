-- The casino-wide jackpot (slots/JackpotService.java, docs/jackpot.md).
--
-- Soul Reels has one jackpot pool for everyone. Every losing spin, by anyone, adds a share of what it lost; five
-- Hidden Kings on a line win the whole pool, and the next pool starts at the seed. `generation` numbers the pools:
-- each has exactly one winner, which jackpot_wins' primary key enforces.

ALTER TABLE jackpot_pools ADD COLUMN generation int NOT NULL DEFAULT 1 CHECK (generation >= 1);
COMMENT ON COLUMN jackpot_pools.contribution_bp IS
    'basis points of each losing spin''s loss (its stake minus its win) that go into the pool, rounded up to a cent';

CREATE TABLE jackpot_wins (
    game_id    uuid NOT NULL REFERENCES jackpot_pools (game_id),
    generation int NOT NULL,
    round_id   uuid NOT NULL UNIQUE REFERENCES slot_rounds (id),
    user_id    uuid NOT NULL REFERENCES users (id),
    amount     bigint NOT NULL CHECK (amount > 0),
    won_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (game_id, generation)
);

-- Jackpots won before this migration, oldest first, are the first pools.
INSERT INTO jackpot_wins (game_id, generation, round_id, user_id, amount, won_at)
SELECT r.game_id, row_number() OVER (PARTITION BY r.game_id ORDER BY t.created_at, t.id), r.id, w.user_id, t.amount,
       t.created_at
FROM transactions t
JOIN slot_rounds r ON r.id = t.slot_round_id
JOIN wallets w ON w.id = t.wallet_id
WHERE t.type = 'JACKPOT_WIN';

UPDATE jackpot_pools p SET generation = 1 + (SELECT count(*) FROM jackpot_wins w WHERE w.game_id = p.game_id);

-- 2% of every losing spin's loss (it was 1% of every paid spin's stake, won or lost). The seed stays 5,000 NTK.
UPDATE jackpot_pools SET contribution_bp = 200;
