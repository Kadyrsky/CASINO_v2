package win.naebka.auth;

import java.util.UUID;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;
import win.naebka.common.ErrorCode;
import win.naebka.common.Exceptions;

/** The authenticated caller, derived from the JWT (subject = user id, jti = session id). */
public record AuthUser(UUID id, String username, String role, UUID sessionId) {

    public boolean isAdmin() {
        return "ADMIN".equals(role);
    }

    public static AuthUser fromJwt(Jwt jwt) {
        return new AuthUser(UUID.fromString(jwt.getSubject()), jwt.getClaimAsString("username"),
                jwt.getClaimAsString("role"), UUID.fromString(jwt.getId()));
    }

    public static AuthUser current() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth instanceof JwtAuthenticationToken token) {
            return fromJwt(token.getToken());
        }
        throw new Exceptions.DomainException(ErrorCode.UNAUTHORIZED, "Authentication required");
    }
}
