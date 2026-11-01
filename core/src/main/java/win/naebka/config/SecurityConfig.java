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
import jakarta.servlet.http.HttpServletResponse;
import win.naebka.auth.JwtService;
import win.naebka.common.ErrorCode;
import win.naebka.common.GlobalExceptionHandler;
import win.naebka.common.Json;

@Configuration
@EnableMethodSecurity
public class SecurityConfig {

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
                .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .authorizeHttpRequests(a -> a
                        .requestMatchers(HttpMethod.POST, "/api/auth/register", "/api/auth/login", "/api/auth/steam").permitAll()
                        .requestMatchers(HttpMethod.GET, "/api/config", "/api/matches/**", "/api/slots/games",
                                "/api/slots/jackpot", "/api/poker/tables/**", "/api/chat/rooms/**").permitAll()
                        .requestMatchers("/api/docs/**", "/api/openapi.json/**", "/swagger-ui/**", "/actuator/health",
                                "/ws/**").permitAll()
                        .requestMatchers("/api/admin/**").hasRole("ADMIN")
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
