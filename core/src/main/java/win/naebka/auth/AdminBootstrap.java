package win.naebka.auth;

import java.time.LocalDate;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;
import win.naebka.config.NaebkaProperties;
import win.naebka.wallet.WalletService;

/** Creates the configured admin account on first start (needed to work the manual-review queue). */
@Component
public class AdminBootstrap {
    private static final Logger log = LoggerFactory.getLogger(AdminBootstrap.class);

    private final UserRepository users;
    private final PasswordEncoder encoder;
    private final WalletService wallets;
    private final NaebkaProperties props;

    public AdminBootstrap(UserRepository users, PasswordEncoder encoder, WalletService wallets, NaebkaProperties props) {
        this.users = users;
        this.encoder = encoder;
        this.wallets = wallets;
        this.props = props;
    }

    @EventListener(ApplicationReadyEvent.class)
    @Transactional
    public void ensureAdmin() {
        String username = props.admin().username();
        if (username == null || username.isBlank() || users.usernameExists(username)) {
            return;
        }
        var id = users.insert(username, username + "@admin.naebka.local", encoder.encode(props.admin().password()),
                "ADMIN", LocalDate.of(1990, 1, 1), "CZ");
        wallets.createWallet(id, 0);
        log.info("Created admin account '{}'", username);
    }
}
