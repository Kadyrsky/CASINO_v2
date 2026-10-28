package win.naebka.kyc;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.time.LocalDate;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import win.naebka.auth.AuthUser;

/** Player verification and the admin KYC review queue ({@code /api/admin/**} is ADMIN-only in SecurityConfig). */
@RestController
public class KycController {
    private final KycService kyc;

    public KycController(KycService kyc) {
        this.kyc = kyc;
    }

    public record SubmitRequest(
            @NotBlank @Size(max = 60) @Pattern(regexp = "[\\p{L} .'-]+") String firstName,
            @NotBlank @Size(max = 60) @Pattern(regexp = "[\\p{L} .'-]+") String lastName,
            @NotBlank @Pattern(regexp = "PASSPORT|ID_CARD|DRIVING_LICENCE") String documentType,
            @NotBlank @Pattern(regexp = "[A-Za-z0-9 -]{6,20}") String documentNumber,
            @NotNull LocalDate documentExpiry) {}

    public record RejectRequest(@NotBlank @Size(max = 500) String reason) {}

    @GetMapping("/api/kyc")
    public KycService.KycView status() {
        return kyc.view(AuthUser.current().id());
    }

    @PostMapping("/api/kyc/submissions")
    @ResponseStatus(HttpStatus.CREATED)
    public KycService.KycView submit(@Valid @RequestBody SubmitRequest req) {
        var document = new KycService.Document(req.firstName().trim(), req.lastName().trim(), req.documentType(),
                req.documentNumber().replaceAll("[ -]", "").toUpperCase(Locale.ROOT), req.documentExpiry());
        return kyc.submit(AuthUser.current().id(), document);
    }

    @GetMapping("/api/admin/kyc/queue")
    public List<KycRepository.Submission> queue() {
        return kyc.reviewQueue();
    }

    @PostMapping("/api/admin/kyc/submissions/{id}/approve")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void approve(@PathVariable UUID id) {
        kyc.approve(id, AuthUser.current().id());
    }

    @PostMapping("/api/admin/kyc/submissions/{id}/reject")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void reject(@PathVariable UUID id, @Valid @RequestBody RejectRequest req) {
        kyc.reject(id, AuthUser.current().id(), req.reason());
    }
}
