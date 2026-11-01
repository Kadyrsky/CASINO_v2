package win.naebka.eth;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import win.naebka.auth.AuthUser;
import win.naebka.common.Json;
import win.naebka.common.Money;
import win.naebka.common.TxRetry;
import win.naebka.config.NaebkaProperties;

/** MetaMask + Sepolia: wallet linking and deposit status for players, plus the admin view of blocked deposits. */
@RestController
public class EthController {
    private final EthLinkService links;
    private final EthDepositService deposits;
    private final EthDepositPoller poller;
    private final JdbcClient jdbc;
    private final TxRetry tx;
    private final NaebkaProperties props;

    public EthController(EthLinkService links, EthDepositService deposits, EthDepositPoller poller, JdbcClient jdbc,
                         TxRetry tx, NaebkaProperties props) {
        this.links = links;
        this.deposits = deposits;
        this.poller = poller;
        this.jdbc = jdbc;
        this.tx = tx;
        this.props = props;
    }

    public record DepositView(UUID id, String txHash, String fromAddress, String amountEth, BigDecimal amountTokens,
                              String status, String holdReason, long blockNumber, Instant createdAt) {
        static DepositView of(EthDepositService.Payment p) {
            return new DepositView(p.id(), p.txHash(), p.fromAddress(), Eth.weiToEth(p.amountWei()),
                    p.amountMinor() == null ? null : Money.toTokens(p.amountMinor()), p.status(), p.holdReason(),
                    p.blockNumber(), p.createdAt());
        }
    }

    public record EthStatus(boolean enabled, long chainId, String contractAddress, BigDecimal tokensPerEth,
                            int confirmations, String linkedAddress, List<DepositView> deposits) {}

    public record LinkMessageRequest(@NotBlank String address) {}

    public record LinkMessage(String message) {}

    public record LinkRequest(@NotBlank String signature) {}

    @GetMapping("/api/wallet/eth")
    public EthStatus status() {
        UUID userId = AuthUser.current().id();
        var eth = props.eth();
        return new EthStatus(eth.configured(), eth.chainId(), eth.configured() ? eth.contractAddress().trim() : null,
                eth.tokensPerEth(), eth.confirmations(), links.linkedAddress(userId).orElse(null),
                deposits.ofUser(userId, 20).stream().map(DepositView::of).toList());
    }

    @PostMapping("/api/wallet/eth/link-message")
    public LinkMessage linkMessage(@Valid @RequestBody LinkMessageRequest req) {
        AuthUser user = AuthUser.current();
        return new LinkMessage(links.createLinkMessage(user.id(), user.username(), req.address()));
    }

    @PostMapping("/api/wallet/eth/link")
    public EthStatus link(@Valid @RequestBody LinkRequest req) {
        links.link(AuthUser.current().id(), req.signature());
        return status();
    }

    @DeleteMapping("/api/wallet/eth/link")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void unlink() {
        links.unlink(AuthUser.current().id());
    }

    // ---------------- admin ----------------

    @GetMapping("/api/admin/eth")
    public Map<String, Object> adminStatus() {
        return Map.of("poller", poller.status(),
                "openDeposits", deposits.open(100).stream().map(DepositView::of).toList());
    }

    /** Re-runs the checks for a held or unlinked deposit (e.g. after a limit period rolled over). */
    @PostMapping("/api/admin/eth/deposits/{id}/retry")
    public Map<String, String> retry(@PathVariable UUID id) {
        String status = tx.inTransaction(() -> {
            String result = deposits.tryCredit(id);
            jdbc.sql("INSERT INTO admin_audit_log (admin_id, action, target, details) VALUES (?, ?, ?, ?::jsonb)")
                    .params(AuthUser.current().id(), "ETH_DEPOSIT_RETRIED", id.toString(),
                            Json.write(Map.of("result", result))).update();
            return result;
        });
        return Map.of("status", status);
    }
}
