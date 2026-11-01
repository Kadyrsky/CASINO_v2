package win.naebka.live;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
import java.math.BigDecimal;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import win.naebka.auth.AuthUser;
import win.naebka.common.Cursor;
import win.naebka.common.Exceptions;
import win.naebka.wallet.WalletController;

@RestController
public class LiveController {
    private final MatchService matches;
    private final BetService bets;

    public LiveController(MatchService matches, BetService bets) {
        this.matches = matches;
        this.bets = bets;
    }

    /** status = live (default) | recent | all */
    @GetMapping("/api/matches")
    public List<MatchService.MatchView> list(@RequestParam(required = false) String status) {
        return matches.list(status);
    }

    @GetMapping("/api/matches/{id}")
    public Map<String, Object> get(@PathVariable UUID id) {
        var match = matches.view(id).orElseThrow(() -> new Exceptions.NotFoundException("Match"));
        return Map.of("match", match, "events", matches.recentEvents(id, 50), "oddsHistory", matches.oddsHistory(id));
    }

    public record PlaceBetRequest(@NotNull UUID selectionId, @NotNull BigDecimal stakeTokens, BigDecimal expectedOdds,
                                  Boolean acceptHigherOdds) {}

    @PostMapping("/api/bets")
    @ResponseStatus(HttpStatus.CREATED)
    public BetService.BetView place(@Valid @RequestBody PlaceBetRequest req,
                                    @RequestHeader(value = "Idempotency-Key", required = false) String key) {
        return bets.place(AuthUser.current().id(), req.selectionId(), req.stakeTokens(), req.expectedOdds(),
                Boolean.TRUE.equals(req.acceptHigherOdds()), WalletController.idempotencyKey(key));
    }

    @GetMapping("/api/bets")
    public Cursor.Page<BetService.BetView> myBets(@RequestParam(required = false) String cursor,
                                                  @RequestParam(required = false) Integer limit) {
        return bets.myBets(AuthUser.current().id(), Cursor.decode(cursor), Cursor.clampLimit(limit));
    }
}
