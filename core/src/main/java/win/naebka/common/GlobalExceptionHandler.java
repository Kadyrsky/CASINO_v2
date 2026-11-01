package win.naebka.common;

import java.net.URI;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.MissingRequestHeaderException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.servlet.resource.NoResourceFoundException;
import win.naebka.common.Exceptions.NaebkaException;

/** Renders every API error as application/problem+json (RFC 7807) with a machine-readable {@code code}. */
@RestControllerAdvice
public class GlobalExceptionHandler {
    private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);

    public static ProblemDetail problem(ErrorCode code, String detail, Map<String, Object> extra) {
        ProblemDetail pd = ProblemDetail.forStatusAndDetail(code.status(), detail);
        pd.setType(URI.create("https://naebka.win/problems/" + code.name().toLowerCase().replace('_', '-')));
        pd.setTitle(code.name());
        pd.setProperty("code", code.name());
        extra.forEach(pd::setProperty);
        return pd;
    }

    @ExceptionHandler(NaebkaException.class)
    public ResponseEntity<ProblemDetail> handle(NaebkaException ex) {
        if (ex instanceof Exceptions.InfrastructureException) {
            log.warn("Infrastructure error {}: {}", ex.code(), ex.getMessage());
        }
        return ResponseEntity.status(ex.code().status()).body(problem(ex.code(), ex.getMessage(), ex.details()));
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<ProblemDetail> handleValidation(MethodArgumentNotValidException ex) {
        Map<String, Object> fields = new LinkedHashMap<>();
        ex.getBindingResult().getFieldErrors().forEach(f -> fields.put(f.getField(), f.getDefaultMessage()));
        return ResponseEntity.badRequest()
                .body(problem(ErrorCode.VALIDATION_FAILED, "Request validation failed", Map.of("fields", fields)));
    }

    @ExceptionHandler({HttpMessageNotReadableException.class, MethodArgumentTypeMismatchException.class,
            MissingRequestHeaderException.class})
    public ResponseEntity<ProblemDetail> handleBadRequest(Exception ex) {
        return ResponseEntity.badRequest()
                .body(problem(ErrorCode.VALIDATION_FAILED, "Malformed request: " + ex.getMessage(), Map.of()));
    }

    @ExceptionHandler(AccessDeniedException.class)
    public ResponseEntity<ProblemDetail> handleForbidden(AccessDeniedException ex) {
        return ResponseEntity.status(HttpStatus.FORBIDDEN).body(problem(ErrorCode.FORBIDDEN, "Forbidden", Map.of()));
    }

    @ExceptionHandler(NoResourceFoundException.class)
    public ResponseEntity<ProblemDetail> handleNoResource(NoResourceFoundException ex) {
        return ResponseEntity.status(HttpStatus.NOT_FOUND).body(problem(ErrorCode.NOT_FOUND, "Not found", Map.of()));
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<ProblemDetail> handleUnexpected(Exception ex) {
        String trackingId = UUID.randomUUID().toString();
        log.error("Unhandled error [{}]", trackingId, ex);
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                .body(problem(ErrorCode.INTERNAL_ERROR, "Internal error", Map.of("trackingId", trackingId)));
    }
}
