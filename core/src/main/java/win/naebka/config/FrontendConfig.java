package win.naebka.config;

import java.io.IOException;
import java.util.concurrent.TimeUnit;
import org.springframework.boot.autoconfigure.web.WebProperties;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.io.Resource;
import org.springframework.http.CacheControl;
import org.springframework.web.servlet.config.annotation.ResourceHandlerRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;
import org.springframework.web.servlet.resource.PathResourceResolver;

/**
 * Serves the built SolidJS app (frontend/dist) from the core, replacing the nginx container. The Docker image puts
 * dist in /app/static and points spring.web.resources.static-locations at it; controllers (/api, /ws) still win.
 */
@Configuration
public class FrontendConfig implements WebMvcConfigurer {
    private final String[] locations;

    public FrontendConfig(WebProperties web) {
        this.locations = web.getResources().getStaticLocations();
    }

    @Override
    public void addResourceHandlers(ResourceHandlerRegistry registry) {
        // Vite fingerprints everything under /assets, so it can be cached for good.
        registry.addResourceHandler("/assets/**")
                .addResourceLocations(withSuffix("assets/"))
                .setCacheControl(CacheControl.maxAge(365, TimeUnit.DAYS).cachePublic().immutable());
        // Everything else; index.html must be revalidated so a new deploy is picked up.
        registry.addResourceHandler("/**")
                .addResourceLocations(locations)
                .setCacheControl(CacheControl.noCache())
                .resourceChain(true)
                .addResolver(new SpaResourceResolver());
    }

    private String[] withSuffix(String suffix) {
        String[] out = new String[locations.length];
        for (int i = 0; i < locations.length; i++) {
            out[i] = locations[i].endsWith("/") ? locations[i] + suffix : locations[i] + "/" + suffix;
        }
        return out;
    }

    /** A real file if there is one; otherwise index.html, so client-side routes like /poker/123 load the app. */
    static class SpaResourceResolver extends PathResourceResolver {
        @Override
        protected Resource getResource(String path, Resource location) throws IOException {
            Resource file = location.createRelative(path);
            if (file.exists() && file.isReadable()) {
                return file;
            }
            // Unknown API paths and missing files with an extension stay 404 instead of returning the app.
            if (path.startsWith("api/") || path.startsWith("ws") || path.contains(".")) {
                return null;
            }
            Resource index = location.createRelative("index.html");
            return index.exists() && index.isReadable() ? index : null;
        }
    }
}
