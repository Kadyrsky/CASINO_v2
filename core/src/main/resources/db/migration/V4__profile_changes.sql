-- [ADDED] Players can correct their date of birth and country after registering (KYC takes both from the profile
-- instead of asking again). Every change is kept, so KYC can send submissions after a recent change to review.
CREATE TABLE profile_changes (
    id         bigserial PRIMARY KEY,
    user_id    uuid NOT NULL REFERENCES users (id),
    field      text NOT NULL CHECK (field IN ('date_of_birth', 'country')),
    old_value  text NOT NULL,
    new_value  text NOT NULL,
    changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX profile_changes_user ON profile_changes (user_id, changed_at DESC);
CREATE TRIGGER profile_changes_append_only BEFORE UPDATE OR DELETE ON profile_changes
    FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
