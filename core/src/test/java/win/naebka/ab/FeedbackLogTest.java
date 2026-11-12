package win.naebka.ab;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import win.naebka.common.Json;

class FeedbackLogTest {
    @TempDir
    Path dir;

    @Test
    void appendsOneJsonLinePerEventAndCreatesTheFolder() throws Exception {
        Path file = dir.resolve("data/feedback.jsonl");
        FeedbackLog log = new FeedbackLog(file.toString());
        Map<String, Object> fields = new LinkedHashMap<>();
        fields.put("rating", 4);
        fields.put("message", "Line one\nline \"two\"");
        fields.put("userId", null);
        log.feedback(7, fields);
        log.details(7, Map.of("tags", List.of("love_music")));

        List<String> lines = Files.readAllLines(file);
        assertThat(lines).hasSize(2);
        JsonNode first = Json.read(lines.get(0));
        assertThat(first.path("event").asText()).isEqualTo("feedback");
        assertThat(first.path("id").asLong()).isEqualTo(7);
        assertThat(first.path("rating").asInt()).isEqualTo(4);
        assertThat(first.path("message").asText()).isEqualTo("Line one\nline \"two\"");
        assertThat(first.path("at").asText()).isNotBlank();
        JsonNode second = Json.read(lines.get(1));
        assertThat(second.path("event").asText()).isEqualTo("details");
        assertThat(second.path("tags").get(0).asText()).isEqualTo("love_music");

        // A new log on the same file (a restart) keeps what was there.
        new FeedbackLog(file.toString()).feedback(8, Map.of("rating", 5));
        assertThat(Files.readAllLines(file)).hasSize(3);
    }

    @Test
    void isOffWithoutAFileAndNeverThrows() throws Exception {
        FeedbackLog off = new FeedbackLog("");
        off.feedback(1, Map.of("rating", 3));
        assertThat(off.enabled()).isFalse();

        // A path that can't be written (a folder where the file should be) is logged, not thrown.
        Files.createDirectories(dir.resolve("taken"));
        new FeedbackLog(dir.resolve("taken").toString()).feedback(2, Map.of("rating", 3));
    }
}
