package win.naebka.config;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;

class FrontendConfigTest {
    @TempDir
    Path dist;

    Resource location;
    final FrontendConfig.SpaResourceResolver resolver = new FrontendConfig.SpaResourceResolver();

    @BeforeEach
    void build() throws Exception {
        Files.writeString(dist.resolve("index.html"), "<!doctype html>");
        Files.createDirectories(dist.resolve("assets"));
        Files.writeString(dist.resolve("assets/index-abc123.js"), "console.log(1)");
        location = new FileSystemResource(dist.toString() + "/");
    }

    String resolve(String path) throws Exception {
        Resource r = resolver.getResource(path, location);
        return r == null ? null : dist.relativize(Path.of(r.getURI())).toString().replace('\\', '/');
    }

    @Test
    void servesRealFiles() throws Exception {
        assertThat(resolve("assets/index-abc123.js")).isEqualTo("assets/index-abc123.js");
        assertThat(resolve("index.html")).isEqualTo("index.html");
    }

    @Test
    void clientSideRoutesGetTheApp() throws Exception {
        assertThat(resolve("")).isEqualTo("index.html");
        assertThat(resolve("wallet")).isEqualTo("index.html");
        assertThat(resolve("poker/3f2a")).isEqualTo("index.html");
    }

    @Test
    void apiPathsAndMissingFilesStayNotFound() throws Exception {
        assertThat(resolve("api/nope")).isNull();
        assertThat(resolve("ws")).isNull();
        assertThat(resolve("assets/missing.js")).isNull();
    }

    @Test
    void withoutABuiltFrontendNothingIsServed() throws Exception {
        Files.delete(dist.resolve("index.html"));
        assertThat(resolve("wallet")).isNull();
    }
}
