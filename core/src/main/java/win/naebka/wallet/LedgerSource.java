package win.naebka.wallet;

import java.util.UUID;

/** The single (optional) source a ledger row points at: a bet, a slot round, a poker hand, a BTC or an ETH payment. */
public record LedgerSource(UUID betId, UUID slotRoundId, UUID pokerHandId, UUID btcPaymentId, UUID ethPaymentId) {
    public static final LedgerSource NONE = new LedgerSource(null, null, null, null, null);

    public static LedgerSource bet(UUID id) {
        return new LedgerSource(id, null, null, null, null);
    }

    public static LedgerSource slotRound(UUID id) {
        return new LedgerSource(null, id, null, null, null);
    }

    public static LedgerSource pokerHand(UUID id) {
        return new LedgerSource(null, null, id, null, null);
    }

    public static LedgerSource ethPayment(UUID id) {
        return new LedgerSource(null, null, null, null, id);
    }
}
