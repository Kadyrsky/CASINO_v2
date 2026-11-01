package win.naebka.live;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;
import win.naebka.common.Exceptions;
import win.naebka.common.Money;
import win.naebka.config.NaebkaProperties;
import win.naebka.wallet.LedgerSource;
import win.naebka.wallet.TxType;
import win.naebka.wallet.WalletService;
import win.naebka.ws.WsHub;

/**
 * Settlement Worker (Technical Design: settlement reconciliation).
 *
 * <p>For every ENDED match it fetches the official post-match report and compares it with the
 * watcher's final stream state. Only if they agree are markets SETTLED and payouts written to the
 * ledger; a mismatch, a data-quality flag or a report that never arrives sends the match to the
 * manual review queue (status REVIEW). If the stream lost the match before the end (no stream winner),
 * the report alone decides — recorded as {@code settled by report}.
 *
 * <p>Payouts are idempotent per bet ("bet-payout:{betId}") and bets only move from PENDING, so a crash
 * mid-settlement can simply be retried.
 */
@Service
public class SettlementService {
    private static final Logger log = LoggerFactory.getLogger(SettlementService.class);

    private final JdbcClient jdbc;
    private final MatchReportSource reports;
    private final WalletService wallets;
    private final WsHub ws;
    private final TransactionTemplate tx;
    private final NaebkaProperties props;

    public SettlementService(JdbcClient jdbc, MatchReportSource reports, WalletService wallets, WsHub ws,
                             TransactionTemplate tx, NaebkaProperties props) {
        this.jdbc = jdbc;
        this.reports = reports;
        this.wallets = wallets;
        this.ws = ws;
        this.tx = tx;
        this.props = props;
    }

    record EndedMatch(UUID id, String externalId, Integer streamWinnerSide, Instant endedAt, int attempts) {}

    @Scheduled(fixedDelayString = "${naebka.settlement.poll-seconds}000", initialDelay = 10_000)
    public void settlePending() {
        List<EndedMatch> due = jdbc.sql("""
                SELECT id, external_id, stream_winner_side, ended_at, settle_attempts FROM matches
                WHERE status = 'ENDED' AND (next_settle_at IS NULL OR next_settle_at <= now())
                ORDER BY next_settle_at NULLS FIRST LIMIT 20""")
                .query((rs, i) -> new EndedMatch(rs.getObject(1, UUID.class), rs.getString(2),
                        (Integer) rs.getObject(3), rs.getTimestamp(4).toInstant(), rs.getInt(5)))
                .list();
        for (EndedMatch m : due) {
            try {
                processOne(m);
            } catch (Exceptions.ExternalScraperUnavailableException e) {
                // Leave everything pending; the breaker decides when we try again.
                jdbc.sql("UPDATE matches SET next_settle_at = now() + interval '60 seconds' WHERE status = 'ENDED'")
                        .update();
                log.warn("Settlement paused: {}", e.getMessage());
                return;
            }
        }
    }

    void processOne(EndedMatch m) {
        Optional<MatchReportSource.MatchReport> report = reports.fetchMatchResult(m.externalId());
        if (report.isEmpty()) {
            boolean giveUp = m.endedAt().isBefore(Instant.now().minusSeconds(props.settlement().reviewAfterMinutes() * 60L));
            if (giveUp) {
                toReview(m.id(), "REPORT_UNAVAILABLE");
            } else {
                long backoff = Math.min(600, 30L << Math.min(m.attempts(), 5));
                jdbc.sql("""
                        UPDATE matches SET settle_attempts = settle_attempts + 1,
                               next_settle_at = now() + make_interval(secs => ?) WHERE id = ?""")
                        .params(backoff, m.id()).update();
            }
            return;
        }
        var r = report.get();
        if (r.dataQualityFlag()) {
            toReview(m.id(), "DATA_QUALITY_FLAG");
        } else if (m.streamWinnerSide() != null && m.streamWinnerSide() != r.winnerSide()) {
            toReview(m.id(), "WINNER_MISMATCH: stream=" + m.streamWinnerSide() + " report=" + r.winnerSide());
        } else {
            tx.executeWithoutResult(s -> settle(m.id(), r.winnerSide(), r.durationSeconds()));
        }
    }

    private void toReview(UUID matchId, String reason) {
        jdbc.sql("UPDATE matches SET status = 'REVIEW', review_reason = ? WHERE id = ? AND status = 'ENDED'")
                .params(reason, matchId).update();
        ws.publish("lobby", "MATCH_REVIEW", Map.of("matchId", matchId));
        log.warn("Match {} routed to manual review: {}", matchId, reason);
    }

    /** Settles all markets of a match and pays winners. Also used by admins resolving the review queue. */
    @Transactional
    public void settle(UUID matchId, int winnerSide, int durationSeconds) {
        String status = jdbc.sql("SELECT status FROM matches WHERE id = ? FOR UPDATE").param(matchId)
                .query(String.class).single();
        if (!List.of("ENDED", "REVIEW").contains(status)) {
            throw new Exceptions.DomainException(win.naebka.common.ErrorCode.GAME_STATE_MISMATCH,
                    "Match is " + status + ", cannot settle");
        }
        jdbc.sql("UPDATE match_participants SET is_winner = (side = ?) WHERE match_id = ?")
                .params(winnerSide, matchId).update();

        record MarketRow(UUID id, String type, BigDecimal line) {}
        List<MarketRow> markets = jdbc.sql("SELECT id, market_type, line FROM markets WHERE match_id = ?")
                .param(matchId)
                .query((rs, i) -> new MarketRow(rs.getObject(1, UUID.class), rs.getString(2), rs.getBigDecimal(3)))
                .list();
        for (MarketRow market : markets) {
            Map<String, String> results = switch (market.type()) {
                case "match_winner" -> winnerSide == 1
                        ? Map.of("side1", "WON", "side2", "LOST")
                        : Map.of("side1", "LOST", "side2", "WON");
                case "duration_over_under" -> {
                    int cmp = BigDecimal.valueOf(durationSeconds).compareTo(market.line().multiply(BigDecimal.valueOf(60)));
                    yield cmp > 0 ? Map.of("over", "WON", "under", "LOST")
                            : cmp < 0 ? Map.of("over", "LOST", "under", "WON")
                            : Map.of("over", "VOID", "under", "VOID"); // exactly on the line: push
                }
                default -> throw new IllegalStateException("Unknown market " + market.type());
            };
            results.forEach((key, result) -> jdbc.sql("UPDATE selections SET result = ? WHERE market_id = ? AND outcome_key = ?")
                    .params(result, market.id(), key).update());
            jdbc.sql("UPDATE markets SET status = 'SETTLED' WHERE id = ?").param(market.id()).update();
            settleBets(market.id());
        }
        jdbc.sql("UPDATE matches SET status = 'SETTLED', settled_at = now() WHERE id = ?").param(matchId).update();
        ws.publish(MatchService.topic(matchId), "MATCH_SETTLED", Map.of("matchId", matchId, "winnerSide", winnerSide));
        ws.publish("lobby", "MATCH_SETTLED", Map.of("matchId", matchId));
        log.info("Settled match {} (winner side {}, {} s)", matchId, winnerSide, durationSeconds);
    }

    /** Voids every market and refunds every pending stake. */
    @Transactional
    public void voidMatch(UUID matchId) {
        jdbc.sql("SELECT status FROM matches WHERE id = ? FOR UPDATE").param(matchId).query(String.class).single();
        List<UUID> marketIds = jdbc.sql("UPDATE markets SET status = 'VOID' WHERE match_id = ? AND status <> 'SETTLED' RETURNING id")
                .param(matchId).query(UUID.class).list();
        for (UUID marketId : marketIds) {
            jdbc.sql("UPDATE selections SET result = 'VOID' WHERE market_id = ?").param(marketId).update();
            settleBets(marketId);
        }
        jdbc.sql("UPDATE matches SET status = 'VOID', settled_at = now() WHERE id = ?").param(matchId).update();
        ws.publish(MatchService.topic(matchId), "MATCH_VOID", Map.of("matchId", matchId));
        ws.publish("lobby", "MATCH_SETTLED", Map.of("matchId", matchId));
    }

    private void settleBets(UUID marketId) {
        record PendingBet(UUID id, UUID walletId, UUID userId, long stake, BigDecimal odds, String result) {}
        List<PendingBet> bets = jdbc.sql("""
                SELECT b.id, b.wallet_id, w.user_id, b.stake, b.odds_at_placement, s.result
                FROM bets b JOIN selections s ON s.id = b.selection_id JOIN wallets w ON w.id = b.wallet_id
                WHERE s.market_id = ? AND b.status = 'PENDING' FOR UPDATE OF b""")
                .param(marketId)
                .query((rs, i) -> new PendingBet(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class),
                        rs.getObject(3, UUID.class), rs.getLong(4), rs.getBigDecimal(5), rs.getString(6)))
                .list();
        for (PendingBet bet : bets) {
            long payout = switch (bet.result()) {
                case "WON" -> Money.payout(bet.stake(), bet.odds());
                case "VOID" -> bet.stake();
                default -> 0L;
            };
            jdbc.sql("UPDATE bets SET status = ?, payout = ?, settled_at = now() WHERE id = ? AND status = 'PENDING'")
                    .params(bet.result(), payout, bet.id()).update();
            if ("WON".equals(bet.result())) {
                wallets.credit(bet.walletId(), payout, TxType.BET_PAYOUT, LedgerSource.bet(bet.id()), "bet-payout:" + bet.id());
            } else if ("VOID".equals(bet.result())) {
                wallets.credit(bet.walletId(), payout, TxType.BET_REFUND, LedgerSource.bet(bet.id()), "bet-refund:" + bet.id());
            }
            ws.publishToUser(bet.userId(), "BET_SETTLED", Map.of("betId", bet.id(), "status", bet.result(),
                    "payout", Money.toTokens(payout)));
        }
    }
}
