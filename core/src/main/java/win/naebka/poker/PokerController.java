package win.naebka.poker;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Min;
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
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import win.naebka.auth.AuthUser;
import win.naebka.common.Cursor;
import win.naebka.common.Money;

@RestController
public class PokerController {
    private final PokerService poker;

    public PokerController(PokerService poker) {
        this.poker = poker;
    }

    public record SitRequest(@NotNull @Min(0) Integer seatNo, @NotNull BigDecimal buyInTokens) {}

    public record ActionRequest(@NotNull PlayerAction.PlayerActionType action, Long amount) {}

    @GetMapping("/api/poker/tables")
    public List<PokerService.TableInfo> tables() {
        return poker.tables();
    }

    @GetMapping("/api/poker/tables/{id}")
    public Map<String, Object> table(@PathVariable UUID id) {
        return poker.snapshot(id, null);
    }

    @GetMapping("/api/poker/tables/{id}/me")
    public Map<String, Object> me(@PathVariable UUID id) {
        return poker.snapshot(id, AuthUser.current().id());
    }

    @PostMapping("/api/poker/tables/{id}/sit")
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, Object> sit(@PathVariable UUID id, @Valid @RequestBody SitRequest req, HttpServletRequest http) {
        AuthUser me = AuthUser.current();
        return poker.sit(me.id(), me.username(), id, req.seatNo(), Money.toMinor(req.buyInTokens()), http.getRemoteAddr());
    }

    @PostMapping("/api/poker/tables/{id}/leave")
    public Map<String, Object> leave(@PathVariable UUID id) {
        return poker.leave(AuthUser.current().id(), id);
    }

    /** REST alternative to the poker.action WebSocket command. Amount = chips (minor units) to raise to. */
    @PostMapping("/api/poker/tables/{id}/actions")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void act(@PathVariable UUID id, @Valid @RequestBody ActionRequest req) {
        poker.act(AuthUser.current().id(), id, new PlayerAction(req.action(), req.amount() == null ? 0 : req.amount()));
    }

    @PostMapping("/api/poker/tables/{id}/sit-out")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void sitOut(@PathVariable UUID id) {
        poker.setSittingOut(AuthUser.current().id(), id, true);
    }

    @PostMapping("/api/poker/tables/{id}/sit-in")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void sitIn(@PathVariable UUID id) {
        poker.setSittingOut(AuthUser.current().id(), id, false);
    }

    @GetMapping("/api/poker/history")
    public Cursor.Page<PokerService.HandHistoryView> history(@RequestParam(required = false) String cursor,
                                                            @RequestParam(required = false) Integer limit) {
        return poker.history(AuthUser.current().id(), Cursor.decode(cursor), Cursor.clampLimit(limit));
    }
}
