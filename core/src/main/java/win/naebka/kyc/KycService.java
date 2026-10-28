package win.naebka.kyc;

import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.time.Duration;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Collectors;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import win.naebka.auth.UserRepository;
import win.naebka.common.ErrorCode;
import win.naebka.common.Exceptions.DomainException;
import win.naebka.common.Exceptions.NotFoundException;
import win.naebka.common.Json;
import win.naebka.common.Money;
import win.naebka.common.RateLimiter;
import win.naebka.config.NaebkaProperties;

/**
 * Hybrid KYC (Risk #5). Statuses on the user: NONE → PENDING (admin review) → VERIFIED | REJECTED, or straight to
 * VERIFIED / REJECTED when the automatic checks are conclusive. A REJECTED user may submit again.
 * Tiered limits: until VERIFIED, withdrawals are blocked and lifetime deposits are capped.
 */
@Service
public class KycService {
    private final KycRepository repo;
    private final UserRepository users;
    private final KycProvider provider;
    private final RateLimiter rateLimiter;
    private final JdbcClient jdbc;
    private final NaebkaProperties props;

    public KycService(KycRepository repo, UserRepository users, KycProvider provider, RateLimiter rateLimiter,
                      JdbcClient jdbc, NaebkaProperties props) {
        this.repo = repo;
        this.users = users;
        this.provider = provider;
        this.rateLimiter = rateLimiter;
        this.jdbc = jdbc;
        this.props = props;
    }

    /** Null cap/deposited fields mean the user is verified and unlimited. */
    public record KycView(String status, boolean canWithdraw, BigDecimal depositCapTokens,
                          BigDecimal depositedTokens, KycRepository.Submission latest) {}

    public KycView view(UUID userId) {
        String status = repo.status(userId);
        boolean verified = "VERIFIED".equals(status);
        return new KycView(status, verified,
                verified ? null : BigDecimal.valueOf(props.kyc().unverifiedDepositCapTokens()),
                verified ? null : Money.toTokens(repo.lifetimeDeposits(userId)),
                repo.latest(userId).orElse(null));
    }

    @Transactional
    public KycView submit(UUID userId, KycProvider.Applicant applicant) {
        String status = repo.lockStatus(userId);
        if ("PENDING".equals(status) || "VERIFIED".equals(status)) {
            throw new DomainException(ErrorCode.KYC_ALREADY_SUBMITTED,
                    "PENDING".equals(status) ? "Your verification is already being reviewed" : "You are already verified");
        }
        rateLimiter.hit("kyc-submit:" + userId, 5, Duration.ofDays(1));
        var user = users.findById(userId).orElseThrow(() -> new NotFoundException("User"));
        String documentHash = documentHash(applicant);
        var checks = provider.verify(applicant, new KycProvider.Profile(user.dateOfBirth(), user.country(),
                repo.documentUsedByAnotherUser(documentHash, userId)));

        var outcome = KycProvider.overall(checks);
        String submissionStatus = switch (outcome) {
            case PASS -> "APPROVED";
            case REVIEW -> "PENDING";
            case FAIL -> "REJECTED";
        };
        String reason = outcome == KycProvider.Outcome.PASS ? null : checks.stream()
                .filter(c -> c.outcome() == outcome).map(KycProvider.Check::message).collect(Collectors.joining("; "));
        repo.insert(userId, applicant, documentHash, submissionStatus,
                outcome == KycProvider.Outcome.REVIEW ? null : "AUTO", Json.write(checks), reason);
        repo.setStatus(userId, userStatusFor(submissionStatus));
        return view(userId);
    }

    public List<KycRepository.Submission> reviewQueue() {
        return repo.pending();
    }

    @Transactional
    public void approve(UUID submissionId, UUID adminId) {
        decide(submissionId, adminId, "APPROVED", null);
    }

    @Transactional
    public void reject(UUID submissionId, UUID adminId, String reason) {
        decide(submissionId, adminId, "REJECTED", reason);
    }

    private void decide(UUID submissionId, UUID adminId, String status, String reason) {
        var submission = repo.find(submissionId).orElseThrow(() -> new NotFoundException("KYC submission"));
        repo.lockStatus(submission.userId());
        if (!repo.decide(submissionId, status, adminId, reason)) {
            throw new DomainException(ErrorCode.KYC_NOT_PENDING, "This submission was already decided");
        }
        repo.setStatus(submission.userId(), userStatusFor(status));
        jdbc.sql("INSERT INTO admin_audit_log (admin_id, action, target, details) VALUES (?, ?, ?, ?::jsonb)")
                .params(adminId, "KYC_" + status, submissionId.toString(), Json.write(reason == null
                        ? Map.of("userId", submission.userId())
                        : Map.of("userId", submission.userId(), "reason", reason)))
                .update();
    }

    /** Withdrawals need a verified identity (AML: money only leaves to a known person). */
    public void assertCanWithdraw(UUID userId) {
        if (!"VERIFIED".equals(repo.status(userId))) {
            throw new DomainException(ErrorCode.KYC_REQUIRED, "Verify your identity before withdrawing",
                    Map.of("kycStatus", repo.status(userId)));
        }
    }

    /** Must run inside the deposit's transaction: it locks the user row so concurrent deposits can't beat the cap. */
    public void assertCanDeposit(UUID userId, long amountMinor) {
        String status = repo.lockStatus(userId);
        if ("VERIFIED".equals(status)) {
            return;
        }
        long cap = props.kyc().unverifiedDepositCapTokens() * 100;
        if (repo.lifetimeDeposits(userId) + amountMinor > cap) {
            throw new DomainException(ErrorCode.KYC_REQUIRED,
                    "Unverified accounts can deposit up to " + Money.toTokens(cap) + " tokens in total. "
                            + "Verify your identity to remove the cap.",
                    Map.of("kycStatus", status, "depositCapTokens", Money.toTokens(cap)));
        }
    }

    private static String userStatusFor(String submissionStatus) {
        return switch (submissionStatus) {
            case "APPROVED" -> "VERIFIED";
            case "PENDING" -> "PENDING";
            default -> "REJECTED";
        };
    }

    /** Keyed hash, so the same document is recognised across accounts without storing its number. */
    private String documentHash(KycProvider.Applicant a) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(props.kyc().documentHashKey().getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            String value = a.documentType() + "|" + a.documentCountry() + "|" + a.documentNumber();
            return HexFormat.of().formatHex(mac.doFinal(value.getBytes(StandardCharsets.UTF_8)));
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }
}
