-- Taste test and quick ratings (frontend: TasteTest.tsx, QuickRating.tsx; docs/ab-testing.md).
--
-- With about a hundred visitors, comparing groups that were each given one version can only show big differences.
-- So visitors are also asked directly: two versions side by side, "which do you like more?". Each answer compares two
-- versions for the same person, and the dashboard ranks all versions from all answers (Bradley-Terry).

CREATE TABLE ab_votes (
    id             bigserial PRIMARY KEY,
    visitor_id     uuid NOT NULL,
    user_id        uuid REFERENCES users (id),
    experiment     text NOT NULL,
    -- The pair, in alphabetical order, so a pair is one row whichever side each version was on.
    variant_a      text NOT NULL,
    variant_b      text NOT NULL,
    -- The version shown on the left: to check that people don't just pick a side.
    left_variant   text NOT NULL,
    -- NULL: "no preference".
    winner         text,
    -- Both versions were tried (seen on the page or listened to) before answering.
    previewed_both boolean NOT NULL,
    decision_ms    integer CHECK (decision_ms >= 0),
    created_at     timestamptz NOT NULL DEFAULT now(),
    CHECK (variant_a < variant_b),
    CHECK (left_variant IN (variant_a, variant_b)),
    CHECK (winner IS NULL OR winner IN (variant_a, variant_b)),
    -- Answering the same pair again replaces the earlier answer.
    UNIQUE (visitor_id, experiment, variant_a, variant_b)
);

-- Where a switch came from: the Customize panel, or picking a version in the taste test.
ALTER TABLE ab_switches ADD COLUMN source text NOT NULL DEFAULT 'customize'
    CHECK (source IN ('customize', 'taste_test'));

-- Feedback now also comes from the one-tap rating (a few minutes into a visit) and the end of the taste test, and
-- carries reason chips ("love_music", "hard_to_read", ...). 'general' is an overall rating.
ALTER TABLE feedback ADD COLUMN source text NOT NULL DEFAULT 'button'
    CHECK (source IN ('button', 'pulse', 'taste_test'));
ALTER TABLE feedback ADD COLUMN tags text[] NOT NULL DEFAULT '{}';
ALTER TABLE feedback DROP CONSTRAINT feedback_category_check;
ALTER TABLE feedback ADD CONSTRAINT feedback_category_check CHECK (category IN ('ui', 'bug', 'idea', 'other', 'general'));
