-- Reference data. Tokens (NTK) are the only in-platform currency (High-Level Design §1).
INSERT INTO currencies (code, name, decimals) VALUES ('NTK', 'Naebka Token', 2);

INSERT INTO games (code, name) VALUES ('deadlock', 'Deadlock'), ('cs2', 'Counter-Strike 2');
UPDATE games SET is_active = false WHERE code = 'cs2'; -- future vertical (Risk #3 fallback)

-- Deadlock has two fixed factions; API team 0 = Hidden King, team 1 = Archmother.
INSERT INTO teams (game_id, external_id, name)
SELECT id, '0', 'Hidden King' FROM games WHERE code = 'deadlock'
UNION ALL
SELECT id, '1', 'Archmother' FROM games WHERE code = 'deadlock';

INSERT INTO slot_games (name) VALUES ('Soul Reels');
INSERT INTO jackpot_pools (game_id, amount, seed_amount, contribution_bp)
SELECT id, 500000, 500000, 100 FROM slot_games WHERE name = 'Soul Reels'; -- 5,000.00 NTK seed, 1% contribution

-- Blinds in minor units: 0.50/1.00 and 2.50/5.00 NTK.
INSERT INTO poker_tables (name, currency_id, small_blind, big_blind, max_seats, status)
SELECT 'Patron''s Lounge', id, 50, 100, 6, 'OPEN' FROM currencies WHERE code = 'NTK'
UNION ALL
SELECT 'Cursed Apple', id, 250, 500, 6, 'OPEN' FROM currencies WHERE code = 'NTK'
UNION ALL
SELECT 'Heads-Up Duel', id, 100, 200, 2, 'OPEN' FROM currencies WHERE code = 'NTK';

INSERT INTO chat_rooms (match_id, name) VALUES (NULL, 'Global');
