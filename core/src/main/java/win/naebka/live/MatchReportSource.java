package win.naebka.live;

import java.util.Optional;

/** Source of the official post-match report (DeadlockDataScraper.fetchMatchResult in the LLD). */
public interface MatchReportSource {

    /** winnerSide: 1 or 2; {@code dataQualityFlag}: the report itself is marked unreliable. */
    record MatchReport(int winnerSide, int durationSeconds, boolean dataQualityFlag) {}

    /** Empty when the report is not available yet. */
    Optional<MatchReport> fetchMatchResult(String externalMatchId);
}
