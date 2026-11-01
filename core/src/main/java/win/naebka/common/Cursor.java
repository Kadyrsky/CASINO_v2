package win.naebka.common;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Base64;
import java.util.List;
import java.util.UUID;
import java.util.function.Function;

/**
 * Keyset ("cursor") pagination over (created_at DESC, id DESC) — all history and ledger endpoints use
 * it instead of OFFSET (System Architecture Design: pagination and throttling).
 */
public record Cursor(Instant at, UUID id) {
    public static final int DEFAULT_LIMIT = 25;
    public static final int MAX_LIMIT = 100;

    public String encode() {
        String raw = at.toEpochMilli() + ":" + at.getNano() + ":" + id;
        return Base64.getUrlEncoder().withoutPadding().encodeToString(raw.getBytes(StandardCharsets.UTF_8));
    }

    public static Cursor decode(String encoded) {
        if (encoded == null || encoded.isBlank()) {
            return null;
        }
        try {
            String[] parts = new String(Base64.getUrlDecoder().decode(encoded), StandardCharsets.UTF_8).split(":");
            Instant at = Instant.ofEpochMilli(Long.parseLong(parts[0])).with(java.time.temporal.ChronoField.NANO_OF_SECOND,
                    Long.parseLong(parts[1]));
            return new Cursor(at, UUID.fromString(parts[2]));
        } catch (RuntimeException e) {
            throw new Exceptions.DomainException(ErrorCode.VALIDATION_FAILED, "Invalid cursor");
        }
    }

    public static int clampLimit(Integer limit) {
        if (limit == null || limit <= 0) {
            return DEFAULT_LIMIT;
        }
        return Math.min(limit, MAX_LIMIT);
    }

    /** A page of results plus the cursor of the next page (null when there is none). */
    public record Page<T>(List<T> items, String nextCursor) {
        /** Expects {@code rows} fetched with limit + 1 to detect whether another page exists. */
        public static <T> Page<T> of(List<T> rows, int limit, Function<T, Cursor> cursorOf) {
            if (rows.size() <= limit) {
                return new Page<>(rows, null);
            }
            List<T> items = rows.subList(0, limit);
            return new Page<>(List.copyOf(items), cursorOf.apply(items.get(limit - 1)).encode());
        }
    }
}
