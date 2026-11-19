package win.naebka.auth;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Past;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.time.Duration;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import win.naebka.common.ErrorCode;
import win.naebka.common.RateLimiter;
import win.naebka.config.NaebkaProperties;
import win.naebka.common.Exceptions.DomainException;

@RestController
@RequestMapping("/api/auth")
public class AuthController {
    private final AuthService auth;
    private final SessionRepository sessions;
    private final RateLimiter rateLimiter;
    private final NaebkaProperties props;

    public AuthController(AuthService auth, SessionRepository sessions, RateLimiter rateLimiter, NaebkaProperties props) {
        this.auth = auth;
        this.sessions = sessions;
        this.rateLimiter = rateLimiter;
        this.props = props;
    }

    public record RegisterRequest(
            @NotBlank @Size(min = 3, max = 24) @Pattern(regexp = "[A-Za-z0-9_.-]+") String username,
            @NotBlank @Email String email,
            @NotBlank @Size(min = 8, max = 72) String password,
            @NotNull @Past LocalDate dateOfBirth,
            @NotBlank @Size(min = 2, max = 2) String country) {}

    public record ProfileRequest(@NotNull @Past LocalDate dateOfBirth, @NotBlank @Size(min = 2, max = 2) String country) {}

    public record LoginRequest(@NotBlank String username, @NotBlank String password) {}

    @PostMapping("/register")
    @ResponseStatus(HttpStatus.CREATED)
    public AuthService.TokenResponse register(@Valid @RequestBody RegisterRequest req, HttpServletRequest http) {
        rateLimiter.hit("register-ip:" + http.getRemoteAddr(), props.auth().registrationsPerIpPerHour(), Duration.ofHours(1));
        auth.register(req.username(), req.email(), req.password(), req.dateOfBirth(), req.country());
        return auth.login(req.username(), req.password(), http.getRemoteAddr(), http.getHeader("User-Agent"));
    }

    @PostMapping("/login")
    public AuthService.TokenResponse login(@Valid @RequestBody LoginRequest req, HttpServletRequest http) {
        return auth.login(req.username(), req.password(), http.getRemoteAddr(), http.getHeader("User-Agent"));
    }

    /** Steam OpenID is planned (System Architecture Design) but out of scope for this iteration. */
    @PostMapping("/steam")
    public void steam() {
        throw new DomainException(ErrorCode.NOT_IMPLEMENTED, "Steam OpenID login is not available yet");
    }

    @PostMapping("/refresh")
    public AuthService.TokenResponse refresh() {
        return auth.refresh(AuthUser.current());
    }

    @PostMapping("/logout")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void logout() {
        AuthUser me = AuthUser.current();
        sessions.revoke(me.sessionId(), me.id());
    }

    @GetMapping("/me")
    public AuthService.UserView me() {
        return auth.me(AuthUser.current());
    }

    @PutMapping("/me")
    public AuthService.UserView updateProfile(@Valid @RequestBody ProfileRequest req) {
        return auth.updateProfile(AuthUser.current().id(), req.dateOfBirth(), req.country());
    }

    @GetMapping("/sessions")
    public List<SessionRepository.SessionRow> listSessions() {
        return sessions.listActive(AuthUser.current().id());
    }

    @DeleteMapping("/sessions/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void revokeSession(@PathVariable UUID id) {
        sessions.revoke(id, AuthUser.current().id());
    }

    @PostMapping("/sessions/revoke-all")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void revokeAll() {
        sessions.revokeAll(AuthUser.current().id());
    }
}
