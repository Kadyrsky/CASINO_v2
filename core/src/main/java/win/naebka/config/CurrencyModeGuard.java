package win.naebka.config;

import java.nio.file.Files;
import java.nio.file.Path;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.event.ApplicationStartedEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

/**
 * Startup assertion for the compliance gate (Risk #13): REAL_MONEY cannot be switched on by a
 * config mistake alone — the license sign-off artifact must also be present.
 */
@Component
public class CurrencyModeGuard {
    private static final Logger log = LoggerFactory.getLogger(CurrencyModeGuard.class);

    private final NaebkaProperties props;

    public CurrencyModeGuard(NaebkaProperties props) {
        this.props = props;
    }

    @EventListener(ApplicationStartedEvent.class)
    public void assertCurrencyMode() {
        if (props.currencyMode() == NaebkaProperties.CurrencyMode.REAL_MONEY
                && !Files.isRegularFile(Path.of(props.licenseSignoffFile()))) {
            throw new IllegalStateException("REAL_MONEY mode requires the license sign-off file at "
                    + props.licenseSignoffFile() + " — refusing to start");
        }
        log.info("Currency mode: {}", props.currencyMode());
    }
}
