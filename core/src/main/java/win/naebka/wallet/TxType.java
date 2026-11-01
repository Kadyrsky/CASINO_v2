package win.naebka.wallet;

/** Ledger row types (transactions.type). */
public enum TxType {
    DEPOSIT, WITHDRAWAL,
    BET_STAKE, BET_PAYOUT, BET_REFUND,
    SLOT_BET, SLOT_WIN, JACKPOT_WIN,
    POKER_BUY_IN, POKER_CASH_OUT,
    ADJUSTMENT
}
