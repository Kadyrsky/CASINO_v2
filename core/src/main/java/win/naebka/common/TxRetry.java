package win.naebka.common;

import java.util.function.Supplier;
import org.springframework.dao.PessimisticLockingFailureException;
import org.springframework.dao.QueryTimeoutException;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * DatabaseTimeoutException policy from the LLD: retry the whole transaction with backoff
 * (100ms, 300ms, 500ms); after the last failure the transaction is rolled back and the client gets 503.
 */
@Component
public class TxRetry {
    private static final long[] BACKOFF_MS = {100, 300, 500};

    private final TransactionTemplate tx;

    public TxRetry(TransactionTemplate tx) {
        this.tx = tx;
    }

    public <T> T inTransaction(Supplier<T> work) {
        for (int attempt = 0; ; attempt++) {
            try {
                return tx.execute(status -> work.get());
            } catch (PessimisticLockingFailureException | QueryTimeoutException e) {
                if (attempt >= BACKOFF_MS.length) {
                    throw new Exceptions.DatabaseTimeoutException();
                }
                sleep(BACKOFF_MS[attempt]);
            }
        }
    }

    private static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new Exceptions.DatabaseTimeoutException();
        }
    }
}
