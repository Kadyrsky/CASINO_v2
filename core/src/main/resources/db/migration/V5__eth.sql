-- [ADDED] MetaMask + Sepolia deposits (course web3 lab). Sepolia test ETH has no value, so this stays
-- inside PLAY_MONEY mode: an on-chain deposit is just another way to receive play tokens.

-- One linked Ethereum address per user, proven by a signed message (see eth/EthLinkService).
CREATE TABLE wallet_addresses (
    user_id   uuid PRIMARY KEY REFERENCES users (id),
    chain_id  bigint NOT NULL,
    address   text NOT NULL CHECK (address ~ '^0x[0-9a-f]{40}$'), -- stored lower-case
    linked_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (chain_id, address)
);

-- Every Deposited event seen on chain, credited or not. (chain, tx, log index) identifies an event.
CREATE TABLE eth_payments (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    chain_id     bigint NOT NULL,
    contract     text NOT NULL,
    tx_hash      text NOT NULL,
    log_index    int NOT NULL,
    block_number bigint NOT NULL,
    from_address text NOT NULL,
    amount_wei   numeric(78, 0) NOT NULL CHECK (amount_wei > 0),
    user_id      uuid REFERENCES users (id),
    amount_minor bigint CHECK (amount_minor > 0),
    -- credited: tokens are in the ledger; unlinked: no account has this address yet (credited on link);
    -- held: an account exists but a limit, self-exclusion or the max deposit blocked it (admin can retry).
    status       text NOT NULL CHECK (status IN ('credited', 'unlinked', 'held')),
    hold_reason  text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    credited_at  timestamptz,
    UNIQUE (chain_id, tx_hash, log_index)
);
CREATE INDEX eth_payments_open ON eth_payments (from_address) WHERE status <> 'credited';
CREATE INDEX eth_payments_user ON eth_payments (user_id, created_at DESC);

-- Last block the deposit poller has fully processed, per chain and contract.
CREATE TABLE chain_cursors (
    chain_id   bigint NOT NULL,
    contract   text NOT NULL,
    last_block bigint NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id, contract)
);

-- Ledger rows can point at an ETH payment. Still "a ledger row has at most one source".
ALTER TABLE transactions ADD COLUMN eth_payment_id uuid REFERENCES eth_payments (id);

DO $$
DECLARE c text;
BEGIN
    SELECT conname INTO c FROM pg_constraint
    WHERE conrelid = 'transactions'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%num_nonnulls%';
    IF c IS NOT NULL THEN
        EXECUTE format('ALTER TABLE transactions DROP CONSTRAINT %I', c);
    END IF;
END $$;

ALTER TABLE transactions ADD CONSTRAINT transactions_one_source
    CHECK (num_nonnulls(bet_id, slot_round_id, poker_hand_id, btc_payment_id, eth_payment_id) <= 1);
