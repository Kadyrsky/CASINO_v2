package win.naebka.common;

import java.util.Map;

/**
 * Exception hierarchy from the Low-Level Design: DomainExceptions (business errors) and
 * InfrastructureExceptions (system errors). All carry an {@link ErrorCode} so the global handler can
 * render RFC 7807 problems and the WebSocket layer can render ERROR frames.
 */
public final class Exceptions {
    private Exceptions() {}

    public abstract static class NaebkaException extends RuntimeException {
        private final ErrorCode code;
        private final Map<String, Object> details;

        protected NaebkaException(ErrorCode code, String message, Map<String, Object> details) {
            super(message);
            this.code = code;
            this.details = details == null ? Map.of() : details;
        }

        public ErrorCode code() {
            return code;
        }

        public Map<String, Object> details() {
            return details;
        }
    }

    // ---------------- Domain exceptions ----------------

    public static class DomainException extends NaebkaException {
        public DomainException(ErrorCode code, String message) {
            this(code, message, Map.of());
        }

        public DomainException(ErrorCode code, String message, Map<String, Object> details) {
            super(code, message, details);
        }
    }

    public static class InsufficientBalanceException extends DomainException {
        public InsufficientBalanceException() {
            super(ErrorCode.INSUFFICIENT_FUNDS, "Insufficient balance for this action");
        }
    }

    public static class GameStateMismatchException extends DomainException {
        public GameStateMismatchException(String message) {
            super(ErrorCode.GAME_STATE_MISMATCH, message);
        }
    }

    public static class MarketLockedException extends DomainException {
        public MarketLockedException(ErrorCode code, String message) {
            super(code, message);
        }
    }

    public static class InvalidBetAmountException extends DomainException {
        public InvalidBetAmountException(ErrorCode code, String message, Map<String, Object> details) {
            super(code, message, details);
        }
    }

    public static class TableFullException extends DomainException {
        public TableFullException() {
            super(ErrorCode.TABLE_FULL, "Table is full");
        }
    }

    public static class NotFoundException extends DomainException {
        public NotFoundException(String what) {
            super(ErrorCode.NOT_FOUND, what + " not found");
        }
    }

    // ---------------- Infrastructure exceptions ----------------

    public static class InfrastructureException extends NaebkaException {
        public InfrastructureException(ErrorCode code, String message) {
            super(code, message, Map.of());
        }
    }

    public static class DatabaseTimeoutException extends InfrastructureException {
        public DatabaseTimeoutException() {
            super(ErrorCode.DATABASE_TIMEOUT, "The database is busy, please retry shortly");
        }
    }

    public static class ExternalScraperUnavailableException extends InfrastructureException {
        public ExternalScraperUnavailableException(String message) {
            super(ErrorCode.EXTERNAL_SOURCE_UNAVAILABLE, message);
        }
    }

    public static class RNGVerificationFailedException extends InfrastructureException {
        public RNGVerificationFailedException(String message) {
            super(ErrorCode.RNG_VERIFICATION_FAILED, message);
        }
    }
}
