package win.naebka.wallet;

import jakarta.validation.Valid;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import win.naebka.auth.AuthUser;
import win.naebka.common.Cursor;
import win.naebka.common.ErrorCode;
import win.naebka.common.Exceptions.DomainException;
import win.naebka.common.Money;
import win.naebka.common.TxRetry;
import win.naebka.config.NaebkaProperties;
import win.naebka.kyc.KycService;

/**
 * Wallet endpoints. In PLAY_MONEY mode deposits are credited directly; in REAL_MONEY mode they would be
 * initiated with a PSP and credited by its signed webhook (System Architecture Design) — not built yet.
 */
@RestController
public class WalletController {
    private final WalletService wallets;
    private final ResponsibleGamingService rg;
    private final KycService kyc;
    private final TxRetry tx;
    private final NaebkaProperties props;

    public WalletController(WalletService wallets, ResponsibleGamingService rg, KycService kyc, TxRetry tx,
                            NaebkaProperties props) {
        this.wallets = wallets;
        this.rg = rg;
        this.kyc = kyc;
        this.tx = tx;
        this.props = props;
    }

    public record WalletResponse(UUID walletId, String currency, BigDecimal balance, BigDecimal fiatValue,
                                 String fiatCurrency) {}

    public record AmountRequest(@NotNull @DecimalMin("0.01") BigDecimal amountTokens) {}

    public record TransactionView(UUID id, String type, BigDecimal amount, BigDecimal balanceAfter, UUID betId,
                                  UUID slotRoundId, UUID pokerHandId, Instant createdAt) {
        static TransactionView of(WalletService.LedgerEntry e) {
            return new TransactionView(e.id(), e.type(), Money.toTokens(e.amount()), Money.toTokens(e.balanceAfter()),
                    e.betId(), e.slotRoundId(), e.pokerHandId(), e.createdAt());
        }
    }

    public record LimitRequest(@NotBlank String limitType, @NotBlank String period,
                               @NotNull @DecimalMin("1") BigDecimal amountTokens) {}

    public record SelfExclusionRequest(@Min(1) @Max(3650) Integer days, boolean permanent) {}

    @GetMapping("/api/config")
    public Map<String, Object> config() {
        return Map.of("currencyMode", props.currencyMode(), "tokenFiatRate", props.tokenFiatRate(),
                "fiatCurrency", props.fiatCurrency(), "minStakeTokens", props.betting().minStakeTokens(),
                "maxStakeTokens", props.betting().maxStakeTokens(),
                "licensedCountries", props.registration().licensedCountries());
    }

    @GetMapping("/api/wallet")
    public WalletResponse wallet() {
        var w = wallets.walletOf(AuthUser.current().id());
        BigDecimal tokens = Money.toTokens(w.balance());
        return new WalletResponse(w.walletId(), w.currency(), tokens,
                tokens.multiply(props.tokenFiatRate()).setScale(2, java.math.RoundingMode.DOWN), props.fiatCurrency());
    }

    @GetMapping("/api/wallet/transactions")
    public Cursor.Page<TransactionView> transactions(@RequestParam(required = false) String cursor,
                                                     @RequestParam(required = false) Integer limit) {
        int lim = Cursor.clampLimit(limit);
        var page = wallets.history(wallets.walletIdOf(AuthUser.current().id()), Cursor.decode(cursor), lim);
        return new Cursor.Page<>(page.items().stream().map(TransactionView::of).toList(), page.nextCursor());
    }

    @PostMapping("/api/wallet/deposits")
    @ResponseStatus(HttpStatus.CREATED)
    public TransactionView deposit(@Valid @RequestBody AmountRequest req,
                                   @RequestHeader(value = "Idempotency-Key", required = false) String key) {
        if (props.currencyMode() != NaebkaProperties.CurrencyMode.PLAY_MONEY) {
            throw new DomainException(ErrorCode.NOT_IMPLEMENTED, "Real-money deposits go through the PSP");
        }
        UUID userId = AuthUser.current().id();
        long amount = Money.toMinor(req.amountTokens());
        if (amount > props.wallet().maxDepositTokens() * 100) {
            throw new DomainException(ErrorCode.INVALID_AMOUNT,
                    "Maximum single deposit is " + props.wallet().maxDepositTokens() + " tokens");
        }
        String idem = "deposit:" + userId + ":" + requireKey(key);
        return tx.inTransaction(() -> {
            if (wallets.findByKey(idem).isEmpty()) {
                rg.assertCanDeposit(userId, amount);
                kyc.assertCanDeposit(userId, amount);
            }
            return TransactionView.of(wallets.credit(wallets.walletIdOf(userId), amount, TxType.DEPOSIT,
                    LedgerSource.NONE, idem));
        });
    }

    @PostMapping("/api/wallet/withdrawals")
    @ResponseStatus(HttpStatus.CREATED)
    public TransactionView withdraw(@Valid @RequestBody AmountRequest req,
                                    @RequestHeader(value = "Idempotency-Key", required = false) String key) {
        UUID userId = AuthUser.current().id();
        long amount = Money.toMinor(req.amountTokens());
        String idem = "withdrawal:" + userId + ":" + requireKey(key);
        kyc.assertCanWithdraw(userId);
        return tx.inTransaction(() -> TransactionView.of(
                wallets.debit(wallets.walletIdOf(userId), amount, TxType.WITHDRAWAL, LedgerSource.NONE, idem)));
    }

    @GetMapping("/api/rg/limits")
    public List<Map<String, Object>> limits() {
        return rg.limits(AuthUser.current().id()).stream().map(l -> {
            var m = new java.util.LinkedHashMap<String, Object>();
            m.put("limitType", l.limitType());
            m.put("period", l.period());
            m.put("amountTokens", l.amount() == 0 ? null : Money.toTokens(l.amount()));
            m.put("usedTokens", Money.toTokens(l.usedInPeriod()));
            if (l.pendingAmount() != null) {
                m.put("pendingAmountTokens", Money.toTokens(l.pendingAmount()));
                m.put("pendingFrom", l.pendingFrom());
            }
            return (Map<String, Object>) m;
        }).toList();
    }

    @PutMapping("/api/rg/limits")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void setLimit(@Valid @RequestBody LimitRequest req) {
        rg.setLimit(AuthUser.current().id(), req.limitType(), req.period(), Money.toMinor(req.amountTokens()));
    }

    @GetMapping("/api/rg/self-exclusion")
    public ResponsibleGamingService.SelfExclusionView selfExclusion() {
        return rg.activeExclusion(AuthUser.current().id());
    }

    @PostMapping("/api/rg/self-exclusion")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void selfExclude(@Valid @RequestBody SelfExclusionRequest req) {
        if (!req.permanent() && req.days() == null) {
            throw new DomainException(ErrorCode.VALIDATION_FAILED, "Give a number of days or permanent=true");
        }
        rg.selfExclude(AuthUser.current().id(), req.permanent() ? null : req.days());
    }

    static String requireKey(String key) {
        if (key == null || key.isBlank() || key.length() > 100) {
            throw new DomainException(ErrorCode.IDEMPOTENCY_KEY_REQUIRED,
                    "Money-moving requests need an Idempotency-Key header (max 100 chars)");
        }
        return key;
    }

    /** Validates an Idempotency-Key header; shared by every money-moving controller. */
    public static String idempotencyKey(String key) {
        return requireKey(key);
    }
}
