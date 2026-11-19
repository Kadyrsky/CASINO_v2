package win.naebka.config;

import java.io.IOException;
import java.util.List;
import java.util.Map;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.security.config.annotation.method.configuration.EnableMethodSecurity;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.header.writers.ReferrerPolicyHeaderWriter.ReferrerPolicy;
import org.springframework.security.web.header.writers.StaticHeadersWriter;
import jakarta.servlet.http.HttpServletResponse;
import win.naebka.auth.JwtService;
import win.naebka.common.ErrorCode;
import win.naebka.common.GlobalExceptionHandler;
import win.naebka.common.Json;

@Configuration
@EnableMethodSecurity
public class SecurityConfig {
    /**
     * Content-Security-Policy: only the site's own scripts run (the main defence if an XSS bug ever slips in, since
     * the login token is in browser storage). Inline styles stay allowed because SolidJS sets style attributes; images
     * may come from any HTTPS host (hero, item and rank pictures arrive in the match data); the site can't be framed.
     */
    static final String CSP = String.join("; ",
            "default-src 'self'",
            "script-src 'self'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob: https:",
            "media-src 'self' data: blob:",
            "font-src 'self' data:",
            "connect-src 'self'",
            "object-src 'none'",
            "base-uri 'self'",
            "form-action 'self'",
            "frame-ancestors 'none'");


    @Bean
    PasswordEncoder passwordEncoder() {
        return new BCryptPasswordEncoder(12);
    }

    @Bean
    JwtDecoder jwtDecoder(JwtService jwtService) {
        return jwtService.decoder();
    }

    @Bean
    SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
        http.csrf(c -> c.disable())
                // Spring's defaults (nosniff, X-Frame-Options, HSTS over HTTPS) plus a CSP and two privacy headers.
                .headers(h -> h
                        .contentSecurityPolicy(c -> c.policyDirectives(CSP))
                        .referrerPolicy(r -> r.policy(ReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN))
                        .addHeaderWriter(new StaticHeadersWriter("Permissions-Policy",
                                "camera=(), microphone=(), geolocation=(), payment=(), usb=()")))
                .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .authorizeHttpRequests(a -> a
                        .requestMatchers(HttpMethod.POST, "/api/auth/register", "/api/auth/login", "/api/auth/steam").permitAll()
                        // A/B tracking, taste-test answers and feedback work for anonymous visitors too (rate-limited
                        // per visitor and per IP).
                        .requestMatchers(HttpMethod.POST, "/api/ab/assignments", "/api/ab/switches", "/api/ab/goals",
                                "/api/ab/votes", "/api/feedback", "/api/feedback/*/details").permitAll()
                        .requestMatchers(HttpMethod.GET, "/api/config", "/api/matches/**", "/api/live/**", "/api/slots/games",
                                "/api/slots/jackpot", "/api/poker/tables/**", "/api/chat/rooms/**").permitAll()
                        .requestMatchers("/api/docs/**", "/api/openapi.json/**", "/api/swagger-ui/**", "/swagger-ui/**", "/actuator/health",
                                "/ws/**").permitAll()
                        .requestMatchers("/api/admin/**").hasRole("ADMIN")
                        // The frontend (FrontendConfig): every GET/HEAD outside /api is a page or a static file.
                        .requestMatchers(r -> (HttpMethod.GET.matches(r.getMethod()) || HttpMethod.HEAD.matches(r.getMethod()))
                                && !r.getRequestURI().startsWith(r.getContextPath() + "/api/")).permitAll()
                        .anyRequest().authenticated())
                .oauth2ResourceServer(o -> o
                        .jwt(j -> j.jwtAuthenticationConverter(jwt -> new JwtAuthenticationToken(jwt,
                                List.of(new SimpleGrantedAuthority("ROLE_" + jwt.getClaimAsString("role"))),
                                jwt.getSubject())))
                        .authenticationEntryPoint((req, res, ex) -> writeProblem(res, ErrorCode.UNAUTHORIZED,
                                "Authentication required")))
                .exceptionHandling(e -> e.accessDeniedHandler((req, res, ex) -> writeProblem(res, ErrorCode.FORBIDDEN,
                        "Forbidden")));
        return http.build();
    }

    private static void writeProblem(HttpServletResponse res, ErrorCode code, String detail) throws IOException {
        res.setStatus(code.status().value());
        res.setContentType(MediaType.APPLICATION_PROBLEM_JSON_VALUE);
        res.getWriter().write(Json.write(GlobalExceptionHandler.problem(code, detail, Map.of())));
    }
}
