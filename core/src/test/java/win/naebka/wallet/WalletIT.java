package win.naebka.wallet;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.simple.JdbcClient;
import win.naebka.IntegrationTestBase;
import win.naebka.common.Exceptions;
import win.naebka.common.TxRetry;

class WalletIT extends IntegrationTestBase {
    @Autowired
    WalletService wallets;
    @Autowired
    TxRetry tx;
    @Autowired
    JdbcClient jdbc;

    @Test
    void concurrentDebitsNeverOverspend() throws Exception {
        UUID user = newUser(); // signup bonus: 1000.00 NTK = 100_000 minor
        UUID wallet = wallets.walletIdOf(user);
        var pool = Executors.newFixedThreadPool(16);
        List<Future<Boolean>> results = new ArrayList<>();
        for (int i = 0; i < 40; i++) {
            int n = i;
            Callable<Boolean> debit = () -> {
                try {
                    tx.inTransaction(() -> wallets.debit(wallet, 5_000, TxType.WITHDRAWAL, LedgerSource.NONE, "race-" + user + n));
                    return true;
                } catch (Exceptions.InsufficientBalanceException e) {
                    return false;
                }
            };
            results.add(pool.submit(debit));
        }
        long ok = 0;
        for (Future<Boolean> f : results) {
            ok += f.get() ? 1 : 0;
        }
        pool.shutdown();
        assertThat(ok).isEqualTo(20); // 100_000 / 5_000
        assertThat(wallets.walletOf(user).balance()).isZero();
        long ledger = jdbc.sql("SELECT sum(amount) FROM transactions WHERE wallet_id = ?").param(wallet).query(Long.class).single();
        assertThat(ledger).isZero();
    }

    @Test
    void idempotencyKeyMovesMoneyOnce() {
        UUID user = newUser();
        UUID wallet = wallets.walletIdOf(user);
        var first = tx.inTransaction(() -> wallets.credit(wallet, 2_500, TxType.DEPOSIT, LedgerSource.NONE, "dep-" + user));
        var replay = tx.inTransaction(() -> wallets.credit(wallet, 2_500, TxType.DEPOSIT, LedgerSource.NONE, "dep-" + user));
        assertThat(replay.id()).isEqualTo(first.id());
        assertThat(wallets.walletOf(user).balance()).isEqualTo(100_000 + 2_500);
        assertThatThrownBy(() -> tx.inTransaction(() -> wallets.credit(wallet, 9_999, TxType.DEPOSIT, LedgerSource.NONE, "dep-" + user)))
                .isInstanceOf(Exceptions.DomainException.class);
    }

    @Test
    void ledgerIsAppendOnly() {
        UUID user = newUser();
        UUID wallet = wallets.walletIdOf(user);
        assertThatThrownBy(() -> jdbc.sql("UPDATE transactions SET amount = 1 WHERE wallet_id = ?").param(wallet).update())
                .hasMessageContaining("append-only");
    }
}
