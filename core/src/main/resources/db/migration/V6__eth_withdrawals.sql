-- Withdrawals to MetaMask: the core takes the tokens out of the ledger, then pays Sepolia test ETH from the cashier
-- contract with payout(to, amount, withdrawalId), signed by the server's operator key (eth/EthPayoutSender).
CREATE TABLE eth_withdrawals (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      uuid NOT NULL REFERENCES users (id),
    chain_id     bigint NOT NULL,
    contract     text NOT NULL,
    to_address   text NOT NULL CHECK (to_address ~ '^0x[0-9a-f]{40}$'),
    amount_minor bigint NOT NULL CHECK (amount_minor > 0),
    amount_wei   numeric(78, 0) NOT NULL CHECK (amount_wei > 0),
    -- pending: tokens taken, transaction not sent yet; sent: signed and broadcast, waiting to be mined;
    -- confirmed: paid on chain; failed: can't be paid, tokens refunded; review: an admin has to look (not mined in time).
    status       text NOT NULL CHECK (status IN ('pending', 'sent', 'confirmed', 'failed', 'review')),
    nonce        bigint,
    tx_hash      text,
    raw_tx       text,
    error        text,
    attempts     int NOT NULL DEFAULT 0,
    next_try_at  timestamptz NOT NULL DEFAULT now(),
    created_at   timestamptz NOT NULL DEFAULT now(),
    sent_at      timestamptz,
    finished_at  timestamptz
);
CREATE UNIQUE INDEX eth_withdrawals_tx ON eth_withdrawals (chain_id, tx_hash) WHERE tx_hash IS NOT NULL;
CREATE INDEX eth_withdrawals_open ON eth_withdrawals (created_at) WHERE status IN ('pending', 'sent', 'review');
CREATE INDEX eth_withdrawals_user ON eth_withdrawals (user_id, created_at DESC);

-- Ledger rows can point at a withdrawal (the debit, and the refund if it fails). Still at most one source.
ALTER TABLE transactions ADD COLUMN eth_withdrawal_id uuid REFERENCES eth_withdrawals (id);
ALTER TABLE transactions DROP CONSTRAINT transactions_one_source;
ALTER TABLE transactions ADD CONSTRAINT transactions_one_source
    CHECK (num_nonnulls(bet_id, slot_round_id, poker_hand_id, btc_payment_id, eth_payment_id, eth_withdrawal_id) <= 1);
