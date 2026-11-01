package win.naebka.live;

import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import win.naebka.config.NaebkaProperties;

/** Suspends markets of matches whose watcher went silent (Risk #14: "STALE auto-suspend"). */
@Component
public class LiveWatchdog {
    private static final int ABANDON_AFTER_MINUTES = 20;

    private final MatchService matches;
    private final NaebkaProperties props;

    public LiveWatchdog(MatchService matches, NaebkaProperties props) {
        this.matches = matches;
        this.props = props;
    }

    @Scheduled(fixedDelay = 10_000, initialDelay = 15_000)
    public void check() {
        matches.markStale(props.betting().staleAfterSeconds());
        matches.endAbandoned(ABANDON_AFTER_MINUTES);
    }
}
