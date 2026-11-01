package win.naebka.auth;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.Period;
import java.util.HexFormat;
import java.util.Locale;
import java.util.UUID;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import win.naebka.common.ErrorCode;
import win.naebka.common.Exceptions.DomainException;
import win.naebka.common.RateLimiter;
import win.naebka.config.NaebkaProperties;
import win.naebka.wallet.WalletService;

@Service
public class AuthService {
    private final UserRepository users;
    private final SessionRepository sessions;
    private final PasswordEncoder passwordEncoder;
    private final JwtService jwt;
    private final WalletService wallets;
    private final RateLimiter rateLimiter;
    private final NaebkaProperties props;

    public AuthService(UserRepository users, SessionRepository sessions, PasswordEncoder passwordEncoder, JwtService jwt,
                       WalletService wallets, RateLimiter rateLimiter, NaebkaProperties props) {
        this.users = users;
        this.sessions = sessions;
        this.passwordEncoder = passwordEncoder;
        this.jwt = jwt;
        this.wallets = wallets;
        this.rateLimiter = rateLimiter;
        this.props = props;
    }

    public record TokenResponse(String token, Instant expiresAt, UserView user) {}

    public record UserView(UUID id, String username, String email, String role, String country, Instant createdAt) {
        static UserView of(UserRepository.UserRow u) {
            return new UserView(u.id(), u.username(), u.email(), u.role(), u.country(), u.createdAt());
        }
    }

    @Transactional
    public UUID register(String username, String email, String password, LocalDate dateOfBirth, String country) {
        String cc = country.toUpperCase(Locale.ROOT);
        if (Period.between(dateOfBirth, LocalDate.now()).getYears() < props.registration().minAge()) {
            throw new DomainException(ErrorCode.UNDERAGE, "You must be at least " + props.registration().minAge());
        }
        if (!props.registration().licensedCountries().contains(cc)) {
            throw new DomainException(ErrorCode.COUNTRY_NOT_LICENSED, "Naebka is not available in " + cc);
        }
        if (users.usernameExists(username)) {
            throw new DomainException(ErrorCode.USERNAME_TAKEN, "Username already taken");
        }
        if (users.emailExists(email)) {
            throw new DomainException(ErrorCode.EMAIL_TAKEN, "Email already registered");
        }
        UUID id = users.insert(username, email, passwordEncoder.encode(password), "PLAYER", dateOfBirth, cc);
        wallets.createWallet(id, props.wallet().signupBonusTokens() * 100);
        return id;
    }

    @Transactional(noRollbackFor = DomainException.class)
    public TokenResponse login(String username, String password, String ip, String userAgent) {
        rateLimiter.hit("login-ip:" + ip, 30, Duration.ofMinutes(15));
        var user = users.findByUsername(username)
                .orElseThrow(() -> new DomainException(ErrorCode.INVALID_CREDENTIALS, "Invalid username or password"));
        if (user.lockedUntil() != null && user.lockedUntil().isAfter(Instant.now())) {
            throw new DomainException(ErrorCode.ACCOUNT_LOCKED,
                    "Too many failed logins. Try again after " + user.lockedUntil());
        }
        if (!passwordEncoder.matches(password, user.passwordHash())) {
            users.recordFailedLogin(user.id(), props.auth().maxFailedLogins(), props.auth().lockoutMinutes());
            throw new DomainException(ErrorCode.INVALID_CREDENTIALS, "Invalid username or password");
        }
        if ("blocked".equals(user.status())) {
            throw new DomainException(ErrorCode.ACCOUNT_BLOCKED, "Account is blocked");
        }
        users.resetFailedLogins(user.id());
        UUID sessionId = UUID.randomUUID();
        Instant expiresAt = jwt.expiryFromNow();
        String token = jwt.issue(user.id(), user.username(), user.role(), sessionId, expiresAt);
        sessions.insert(sessionId, user.id(), sha256(token), ip, truncate(userAgent), expiresAt);
        return new TokenResponse(token, expiresAt, UserView.of(user));
    }

    @Transactional
    public TokenResponse refresh(AuthUser caller) {
        var user = users.findById(caller.id()).orElseThrow();
        Instant expiresAt = jwt.expiryFromNow();
        String token = jwt.issue(user.id(), user.username(), user.role(), caller.sessionId(), expiresAt);
        sessions.extend(caller.sessionId(), sha256(token), expiresAt);
        return new TokenResponse(token, expiresAt, UserView.of(user));
    }

    public UserView me(AuthUser caller) {
        return UserView.of(users.findById(caller.id()).orElseThrow());
    }

    static String sha256(String value) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    private static String truncate(String s) {
        return s == null ? null : s.substring(0, Math.min(s.length(), 255));
    }
}
