package win.naebka.ab;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import win.naebka.common.Json;

/**
 * A second copy of every piece of feedback, as a file on the machine that runs Naebka: one JSON object per line
 * (JSON Lines), appended and never rewritten, so it survives a lost database and can be read with any text editor,
 * grep, or a spreadsheet's JSON import. Off unless naebka.feedback.file (NAEBKA_FEEDBACK_FILE) is set; both Compose
 * files point it at a folder on the host. Writing never fails a request: the database stays the main copy.
 */
@Component
public class FeedbackLog {
    private static final Logger log = LoggerFactory.getLogger(FeedbackLog.class);

    private final Path file;

    public FeedbackLog(@Value("${naebka.feedback.file:}") String file) {
        this.file = file == null || file.isBlank() ? null : Path.of(file);
        if (this.file != null) {
            log.info("Feedback is also written to {}", this.file.toAbsolutePath());
        }
    }

    /** A new rating or comment. */
    public void feedback(long id, Map<String, Object> fields) {
        Map<String, Object> line = new LinkedHashMap<>();
        line.put("event", "feedback");
        line.put("id", id);
        line.put("at", Instant.now().toString());
        line.putAll(fields);
        append(line);
    }

    /** Reasons and a comment added to an earlier rating (same id). */
    public void details(long id, Map<String, Object> fields) {
        Map<String, Object> line = new LinkedHashMap<>();
        line.put("event", "details");
        line.put("id", id);
        line.put("at", Instant.now().toString());
        line.putAll(fields);
        append(line);
    }

    public boolean enabled() {
        return file != null;
    }

    private synchronized void append(Map<String, Object> line) {
        if (file == null) {
            return;
        }
        try {
            if (file.getParent() != null) {
                Files.createDirectories(file.getParent());
            }
            Files.writeString(file, Json.write(line) + "\n", StandardCharsets.UTF_8,
                    StandardOpenOption.CREATE, StandardOpenOption.APPEND, StandardOpenOption.WRITE);
        } catch (IOException | RuntimeException e) {
            log.warn("Could not write feedback {} to {}: {}", line.get("id"), file, e.toString());
        }
    }
}
