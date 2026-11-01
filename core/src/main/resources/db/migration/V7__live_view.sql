-- Live matches page and realtime map.

-- The players of a tracked match (account id, team, hero) and what the watcher knows about it (region, mode, rank
-- score), from its match.discovered event, so the match page can show the rosters.
ALTER TABLE matches ADD COLUMN players jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE matches ADD COLUMN meta jsonb NOT NULL DEFAULT '{}'::jsonb;

UPDATE matches m SET players = coalesce(e.payload -> 'players', '[]'::jsonb),
                     meta = jsonb_strip_nulls(jsonb_build_object('region', e.payload -> 'region',
                         'match_mode', e.payload -> 'match_mode', 'game_mode', e.payload -> 'game_mode',
                         'match_score', e.payload -> 'match_score'))
FROM (SELECT DISTINCT ON (match_id) match_id, payload FROM match_events
      WHERE type = 'match.discovered' ORDER BY match_id, id) e
WHERE e.match_id = m.id;

-- Premium players may watch any live match on the realtime map (others need a big enough bet on it).
ALTER TABLE users ADD COLUMN premium boolean NOT NULL DEFAULT false;
