package win.naebka.slots;

import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.math.BigDecimal;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import win.naebka.auth.AuthUser;
import win.naebka.common.Cursor;
import win.naebka.common.Money;

/**
 * Slots over REST: a spin is a single atomic request/response, so REST fits better than a socket here
 * (the jackpot ticker and wallet balance are still pushed over the WebSocket hub).
 */
@RestController
public class SlotController {
    private final SlotService slots;

    public SlotController(SlotService slots) {
        this.slots = slots;
    }

    public record SpinRequest(@NotNull BigDecimal betPerLine) {}

    public record BonusPickRequest(@NotNull @Min(0) @Max(11) Integer choice) {}

    public record ClientSeedRequest(@Size(max = 64) String clientSeed) {}

    /** Machine definition: reel strips, paylines and paytable, so players can check results themselves. */
    @GetMapping("/api/slots/games")
    public List<Map<String, Object>> games() {
        Map<String, Object> symbols = new LinkedHashMap<>();
        SlotMachine.symbols().forEach((id, s) -> symbols.put(id, Map.of("name", s.name(), "type", s.type(),
                "pays", s.payoutMultipliers())));
        Map<String, Object> game = new LinkedHashMap<>();
        game.put("id", slots.defaultGameId());
        game.put("name", "Soul Reels");
        game.put("rows", SlotMachine.ROWS);
        game.put("columns", SlotMachine.COLUMNS);
        game.put("paylines", SlotMachine.lines());
        game.put("symbols", symbols);
        game.put("reels", SlotMachine.REELS.stream().map(r -> r.availableSymbols().stream().map(Symbol::id).toList()).toList());
        game.put("scatterPays", SlotMachine.PAYTABLE.scatterPays());
        game.put("freeSpinsPerTrigger", SlotMachine.PAYTABLE.freeSpinsPerTrigger());
        game.put("minBetPerLine", Money.toTokens(SlotService.MIN_BET_PER_LINE));
        game.put("maxBetPerLine", Money.toTokens(SlotService.MAX_BET_PER_LINE));
        return List.of(game);
    }

    /** The casino-wide jackpot, public; it then moves on the WebSocket topic "jackpot" (JackpotFeed). */
    @GetMapping("/api/slots/jackpot")
    public JackpotService.JackpotView jackpot() {
        return slots.jackpotView();
    }

    @GetMapping("/api/slots/state")
    public SlotService.StateView state() {
        return slots.state(AuthUser.current().id());
    }

    @PostMapping("/api/slots/spin")
    public SlotService.SpinResult spin(@Valid @RequestBody SpinRequest req) {
        return slots.spin(AuthUser.current().id(), Money.toMinor(req.betPerLine()));
    }

    @PostMapping("/api/slots/free-spin")
    public SlotService.SpinResult freeSpin() {
        return slots.executeFreeSpin(AuthUser.current().id());
    }

    @PostMapping("/api/slots/bonus/pick")
    public SlotService.BonusPickResult pick(@Valid @RequestBody BonusPickRequest req) {
        return slots.playBonusTurn(AuthUser.current().id(), req.choice());
    }

    @GetMapping("/api/slots/rounds")
    public Cursor.Page<SlotService.RoundView> rounds(@RequestParam(required = false) String cursor,
                                                    @RequestParam(required = false) Integer limit) {
        return slots.history(AuthUser.current().id(), Cursor.decode(cursor), Cursor.clampLimit(limit));
    }

    @GetMapping("/api/slots/rounds/{id}/verify")
    public Map<String, Object> verify(@PathVariable UUID id) {
        return slots.verifyRound(AuthUser.current().id(), id);
    }

    @GetMapping("/api/slots/fairness")
    public SlotService.FairnessView fairness() {
        return slots.fairness(AuthUser.current().id());
    }

    @PostMapping("/api/slots/fairness/rotate")
    public SlotService.FairnessView rotate(@Valid @RequestBody(required = false) ClientSeedRequest req) {
        return slots.rotateSeed(AuthUser.current().id(), req == null ? null : req.clientSeed());
    }
}
