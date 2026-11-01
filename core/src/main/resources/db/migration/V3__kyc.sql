-- [ADDED] KYC (Risk #5: "AML/KYC program absent"). Hybrid verification: automatic rule checks decide the clear
-- cases, anything ambiguous goes to the admin manual-review queue. Tiered limits: until a user is VERIFIED they
-- cannot withdraw and their lifetime deposits are capped (naebka.kyc.*).

ALTER TABLE users ADD COLUMN kyc_status text NOT NULL DEFAULT 'NONE'
    CHECK (kyc_status IN ('NONE', 'PENDING', 'VERIFIED', 'REJECTED'));

CREATE TABLE kyc_submissions (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id              uuid NOT NULL REFERENCES users (id),
    first_name           text NOT NULL,
    last_name            text NOT NULL,
    date_of_birth        date NOT NULL,
    document_type        text NOT NULL CHECK (document_type IN ('PASSPORT', 'ID_CARD', 'DRIVING_LICENCE')),
    document_country     char(2) NOT NULL,
    -- Data minimisation: the document number is never stored, only a keyed hash (duplicate detection)
    -- and the last 4 characters (shown to the reviewer).
    document_number_hash text NOT NULL,
    document_number_last4 text NOT NULL,
    document_expiry      date NOT NULL,
    status               text NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
    decided_by           text CHECK (decided_by IN ('AUTO', 'ADMIN')),
    reviewer_id          uuid REFERENCES users (id),
    -- Result of every automatic rule: [{"check": ..., "outcome": "PASS|REVIEW|FAIL", "message": ...}]
    checks               jsonb NOT NULL,
    reason               text,
    created_at           timestamptz NOT NULL DEFAULT now(),
    decided_at           timestamptz,
    CHECK ((status = 'PENDING') = (decided_at IS NULL)),
    CHECK ((decided_by = 'ADMIN') = (reviewer_id IS NOT NULL))
);
CREATE INDEX kyc_submissions_user ON kyc_submissions (user_id, created_at DESC);
CREATE INDEX kyc_submissions_pending ON kyc_submissions (created_at) WHERE status = 'PENDING';
CREATE INDEX kyc_submissions_document ON kyc_submissions (document_number_hash);
