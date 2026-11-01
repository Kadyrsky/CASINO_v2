package win.naebka.common;

import org.springframework.http.HttpStatus;

/**
 * Machine-readable error codes (Technical Design: RFC 7807 errors). {@code wsCode} is the numeric
 * code used in WebSocket ERROR frames (LLD: 1001 insufficient balance, 1005 table full, ...).
 */
public enum ErrorCode {
    // Domain (business) errors
    INSUFFICIENT_FUNDS(HttpStatus.UNPROCESSABLE_ENTITY, 1001),
    GAME_STATE_MISMATCH(HttpStatus.CONFLICT, 1002),
    MARKET_SUSPENDED(HttpStatus.CONFLICT, 1003),
    MARKET_CLOSED(HttpStatus.CONFLICT, 1003),
    PRICE_CHANGED(HttpStatus.CONFLICT, 1006),
    STAKE_BELOW_MIN(HttpStatus.UNPROCESSABLE_ENTITY, 1004),
    STAKE_ABOVE_MAX(HttpStatus.UNPROCESSABLE_ENTITY, 1004),
    INVALID_AMOUNT(HttpStatus.BAD_REQUEST, 1004),
    TABLE_FULL(HttpStatus.CONFLICT, 1005),
    SEAT_TAKEN(HttpStatus.CONFLICT, 1005),
    ALREADY_SEATED(HttpStatus.CONFLICT, 1007),
    NOT_SEATED(HttpStatus.CONFLICT, 1008),
    SAME_IP_AT_TABLE(HttpStatus.FORBIDDEN, 1009),
    BETTOR_IS_PARTICIPANT(HttpStatus.UNPROCESSABLE_ENTITY, 1010),
    LIMIT_EXCEEDED(HttpStatus.UNPROCESSABLE_ENTITY, 1011),
    SELF_EXCLUDED(HttpStatus.FORBIDDEN, 1012),
    IDEMPOTENCY_KEY_REQUIRED(HttpStatus.BAD_REQUEST, 1013),
    IDEMPOTENCY_KEY_REUSED(HttpStatus.CONFLICT, 1014),
    // Auth / account
    USERNAME_TAKEN(HttpStatus.CONFLICT, 2001),
    EMAIL_TAKEN(HttpStatus.CONFLICT, 2002),
    UNDERAGE(HttpStatus.UNPROCESSABLE_ENTITY, 2003),
    COUNTRY_NOT_LICENSED(HttpStatus.UNPROCESSABLE_ENTITY, 2004),
    INVALID_CREDENTIALS(HttpStatus.UNAUTHORIZED, 2005),
    ACCOUNT_LOCKED(HttpStatus.LOCKED, 2006),
    ACCOUNT_BLOCKED(HttpStatus.FORBIDDEN, 2007),
    UNAUTHORIZED(HttpStatus.UNAUTHORIZED, 2008),
    FORBIDDEN(HttpStatus.FORBIDDEN, 2009),
    RATE_LIMITED(HttpStatus.TOO_MANY_REQUESTS, 2010),
    NOT_FOUND(HttpStatus.NOT_FOUND, 2011),
    VALIDATION_FAILED(HttpStatus.BAD_REQUEST, 2012),
    NOT_IMPLEMENTED(HttpStatus.NOT_IMPLEMENTED, 2013),
    // Infrastructure errors
    DATABASE_TIMEOUT(HttpStatus.SERVICE_UNAVAILABLE, 3001),
    EXTERNAL_SOURCE_UNAVAILABLE(HttpStatus.SERVICE_UNAVAILABLE, 3002),
    RNG_VERIFICATION_FAILED(HttpStatus.INTERNAL_SERVER_ERROR, 3003),
    INTERNAL_ERROR(HttpStatus.INTERNAL_SERVER_ERROR, 3000);

    private final HttpStatus status;
    private final int wsCode;

    ErrorCode(HttpStatus status, int wsCode) {
        this.status = status;
        this.wsCode = wsCode;
    }

    public HttpStatus status() {
        return status;
    }

    public int wsCode() {
        return wsCode;
    }
}
