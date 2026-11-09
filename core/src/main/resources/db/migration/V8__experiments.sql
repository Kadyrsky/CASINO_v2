-- A/B experiments and site feedback.
--
-- A visitor is a random id the browser keeps, so anonymous visitors count too; user_id is filled once they log in.
-- Each visitor gets one variant per experiment at random (assigned_variant) and may switch to another one under
-- Appearance (current_variant). Results are counted by the assigned variant, so the comparison stays fair; the
-- switches show which version people prefer.

CREATE TABLE ab_assignments (
    visitor_id       uuid NOT NULL,
    experiment       text NOT NULL,
    assigned_variant text NOT NULL,
    current_variant  text NOT NULL,
    user_id          uuid REFERENCES users (id),
    first_seen       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (visitor_id, experiment)
);
CREATE INDEX ab_assignments_user ON ab_assignments (user_id) WHERE user_id IS NOT NULL;

-- Every time someone changes a version by hand.
CREATE TABLE ab_switches (
    id           bigserial PRIMARY KEY,
    visitor_id   uuid NOT NULL,
    experiment   text NOT NULL,
    from_variant text NOT NULL,
    to_variant   text NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now()
);

-- Goals reached (registered, bet_placed, slot_spin, poker_sit), at most one row per visitor and goal.
CREATE TABLE ab_goals (
    visitor_id uuid NOT NULL,
    goal       text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (visitor_id, goal)
);

CREATE TABLE feedback (
    id         bigserial PRIMARY KEY,
    visitor_id uuid NOT NULL,
    user_id    uuid REFERENCES users (id),
    rating     smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
    category   text NOT NULL CHECK (category IN ('ui', 'bug', 'idea', 'other')),
    message    text CHECK (length(message) <= 2000),
    path       text NOT NULL,
    -- The versions the visitor was on when they wrote it: {"theme": "neon", ...}
    variants   jsonb NOT NULL DEFAULT '{}'::jsonb,
    viewport   text,
    user_agent text,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX feedback_created ON feedback (created_at DESC);
