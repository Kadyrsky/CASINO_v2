package win.naebka.ab;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.RowCallbackHandler;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import win.naebka.auth.AuthUser;
import win.naebka.common.Json;
import win.naebka.common.RateLimiter;

/**
 * A/B experiments and site feedback. The experiments themselves (names, variants, how a visitor is assigned) live in
 * the frontend (src/lib/experiments.ts); the core only stores what visitors saw, switched to and did, and sums it up
 * for the admin dashboard. The write endpoints are public so anonymous visitors count, and rate-limited per IP.
 */
@RestController
public class AbController {
    /** Experiment, variant and goal names: short snake_case words. */
    private static final String NAME = "^[a-z0-9_]{1,40}$";

    private final JdbcClient jdbc;
    private final RateLimiter rateLimiter;

    public AbController(JdbcClient jdbc, RateLimiter rateLimiter) {
        this.jdbc = jdbc;
        this.rateLimiter = rateLimiter;
    }

    public record Assignment(@NotNull @Pattern(regexp = NAME) String experiment,
                             @NotNull @Pattern(regexp = NAME) String assigned,
                             @NotNull @Pattern(regexp = NAME) String current) {}

    public record AssignmentsRequest(@NotNull UUID visitorId, @NotNull @Size(min = 1, max = 20) List<@Valid Assignment> assignments) {}

    public record SwitchRequest(@NotNull UUID visitorId, @NotNull @Pattern(regexp = NAME) String experiment,
                                @NotNull @Pattern(regexp = NAME) String assigned,
                                @NotNull @Pattern(regexp = NAME) String from, @NotNull @Pattern(regexp = NAME) String to) {}

    public record GoalRequest(@NotNull UUID visitorId, @NotNull @Pattern(regexp = NAME) String goal) {}

    public record FeedbackRequest(@NotNull UUID visitorId, @NotNull @Min(1) @Max(5) Integer rating,
                                  @NotNull @Pattern(regexp = "^(ui|bug|idea|other)$") String category,
                                  @Size(max = 2000) String message, @NotNull @Size(max = 200) String path,
                                  @Size(max = 20) Map<@Pattern(regexp = NAME) String, @Pattern(regexp = NAME) String> variants,
                                  @Size(max = 40) String viewport) {}

    /** What a logged-in player picked on other devices, so their versions follow them. */
    public record Mine(UUID visitorId, Map<String, String> choices) {}

    /** Records which version of each experiment the visitor is seeing (and links them to their account if logged in). */
    @PostMapping("/api/ab/assignments")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    @Transactional
    public void assignments(@Valid @RequestBody AssignmentsRequest req, HttpServletRequest http) {
        limit(http, "ab", 120);
        UUID userId = userIdOrNull();
        for (Assignment a : req.assignments()) {
            jdbc.sql("""
                    INSERT INTO ab_assignments (visitor_id, experiment, assigned_variant, current_variant, user_id)
                    VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT (visitor_id, experiment) DO UPDATE
                    SET current_variant = excluded.current_variant,
                        user_id = coalesce(excluded.user_id, ab_assignments.user_id),
                        updated_at = now()""")
                    .params(req.visitorId(), a.experiment(), a.assigned(), a.current(), userId).update();
        }
    }

    /** Someone changed a version by hand under Appearance. */
    @PostMapping("/api/ab/switches")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    @Transactional
    public void switched(@Valid @RequestBody SwitchRequest req, HttpServletRequest http) {
        limit(http, "ab", 120);
        if (req.from().equals(req.to())) {
            return;
        }
        jdbc.sql("INSERT INTO ab_switches (visitor_id, experiment, from_variant, to_variant) VALUES (?, ?, ?, ?)")
                .params(req.visitorId(), req.experiment(), req.from(), req.to()).update();
        jdbc.sql("""
                INSERT INTO ab_assignments (visitor_id, experiment, assigned_variant, current_variant, user_id)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT (visitor_id, experiment) DO UPDATE
                SET current_variant = excluded.current_variant,
                    user_id = coalesce(excluded.user_id, ab_assignments.user_id),
                    updated_at = now()""")
                .params(req.visitorId(), req.experiment(), req.assigned(), req.to(), userIdOrNull()).update();
    }

    /** A goal reached (registered, bet_placed, ...); only the first time per visitor counts. */
    @PostMapping("/api/ab/goals")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void goal(@Valid @RequestBody GoalRequest req, HttpServletRequest http) {
        limit(http, "ab", 120);
        jdbc.sql("INSERT INTO ab_goals (visitor_id, goal) VALUES (?, ?) ON CONFLICT DO NOTHING")
                .params(req.visitorId(), req.goal()).update();
    }

    @GetMapping("/api/ab/mine")
    public Mine mine() {
        UUID userId = AuthUser.current().id();
        UUID visitorId = jdbc.sql("SELECT visitor_id FROM ab_assignments WHERE user_id = ? ORDER BY first_seen LIMIT 1")
                .param(userId).query(UUID.class).optional().orElse(null);
        Map<String, String> choices = new LinkedHashMap<>();
        if (visitorId != null) {
            jdbc.sql("""
                    SELECT experiment, current_variant FROM ab_assignments
                    WHERE visitor_id = ? AND current_variant <> assigned_variant""")
                    .param(visitorId).query((RowCallbackHandler) rs -> choices.put(rs.getString(1), rs.getString(2)));
        }
        return new Mine(visitorId, choices);
    }

    @PostMapping("/api/feedback")
    @ResponseStatus(HttpStatus.CREATED)
    public void feedback(@Valid @RequestBody FeedbackRequest req, HttpServletRequest http) {
        limit(http, "feedback", 10);
        String message = req.message() == null || req.message().isBlank() ? null : req.message().strip();
        String agent = http.getHeader("User-Agent");
        jdbc.sql("""
                INSERT INTO feedback (visitor_id, user_id, rating, category, message, path, variants, viewport, user_agent)
                VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?)""")
                .params(req.visitorId(), userIdOrNull(), req.rating(), req.category(), message, req.path(),
                        Json.write(req.variants() == null ? Map.of() : req.variants()), req.viewport(),
                        agent == null ? null : agent.substring(0, Math.min(agent.length(), 300)))
                .update();
    }

    // ---- Admin dashboard ----

    public record VariantResult(String variant, long visitors, long switchedAway, long onItNow,
                                Map<String, Long> goals, Double avgRating, long ratings) {}

    public record SwitchFlow(String from, String to, long count) {}

    public record ExperimentResult(String experiment, List<VariantResult> variants, List<SwitchFlow> switches) {}

    @GetMapping("/api/admin/ab/results")
    public List<ExperimentResult> results() {
        Map<String, Map<String, long[]>> counts = new LinkedHashMap<>();
        // Per assigned variant: visitors and how many of them moved to another version.
        jdbc.sql("""
                SELECT experiment, assigned_variant, count(*), count(*) FILTER (WHERE current_variant <> assigned_variant)
                FROM ab_assignments GROUP BY 1, 2 ORDER BY 1, 2""")
                .query((RowCallbackHandler) rs -> counts.computeIfAbsent(rs.getString(1), k -> new LinkedHashMap<>())
                        .put(rs.getString(2), new long[] {rs.getLong(3), rs.getLong(4), 0}));
        // Per current variant: how many are on it now (people who kept it plus people who switched to it).
        jdbc.sql("SELECT experiment, current_variant, count(*) FROM ab_assignments GROUP BY 1, 2")
                .query((RowCallbackHandler) rs -> counts.computeIfAbsent(rs.getString(1), k -> new LinkedHashMap<>())
                        .computeIfAbsent(rs.getString(2), k -> new long[3])[2] = rs.getLong(3));

        // Goals reached after the visitor was first shown the experiment, by the variant they were assigned.
        Map<String, Map<String, Long>> goals = new LinkedHashMap<>();
        jdbc.sql("""
                SELECT a.experiment, a.assigned_variant, g.goal, count(DISTINCT a.visitor_id)
                FROM ab_assignments a JOIN ab_goals g ON g.visitor_id = a.visitor_id AND g.created_at >= a.first_seen
                GROUP BY 1, 2, 3""")
                .query((RowCallbackHandler) rs -> goals.computeIfAbsent(rs.getString(1) + "/" + rs.getString(2), k -> new LinkedHashMap<>())
                        .put(rs.getString(3), rs.getLong(4)));

        // Feedback ratings by the version people were on when they wrote it.
        Map<String, double[]> ratings = new LinkedHashMap<>();
        jdbc.sql("""
                SELECT v.key, v.value, avg(f.rating), count(*)
                FROM feedback f, jsonb_each_text(f.variants) v GROUP BY 1, 2""")
                .query((RowCallbackHandler) rs -> ratings.put(rs.getString(1) + "/" + rs.getString(2),
                        new double[] {rs.getDouble(3), rs.getLong(4)}));

        Map<String, List<SwitchFlow>> flows = new LinkedHashMap<>();
        jdbc.sql("""
                SELECT experiment, from_variant, to_variant, count(*) FROM ab_switches
                GROUP BY 1, 2, 3 ORDER BY 4 DESC""")
                .query((RowCallbackHandler) rs -> flows.computeIfAbsent(rs.getString(1), k -> new ArrayList<>())
                        .add(new SwitchFlow(rs.getString(2), rs.getString(3), rs.getLong(4))));

        return counts.entrySet().stream().map(e -> new ExperimentResult(e.getKey(),
                e.getValue().entrySet().stream().map(v -> {
                    String key = e.getKey() + "/" + v.getKey();
                    double[] r = ratings.get(key);
                    long[] c = v.getValue();
                    return new VariantResult(v.getKey(), c[0], c[1], c[2], goals.getOrDefault(key, Map.of()),
                            r == null ? null : r[0], r == null ? 0 : (long) r[1]);
                }).toList(),
                flows.getOrDefault(e.getKey(), List.of()))).toList();
    }

    public record FeedbackView(long id, String username, int rating, String category, String message, String path,
                               Map<String, String> variants, String viewport, String userAgent, Instant createdAt) {}

    @GetMapping("/api/admin/feedback")
    public List<FeedbackView> feedbackList(@RequestParam(required = false) String experiment,
                                           @RequestParam(required = false) String variant) {
        boolean filtered = experiment != null && !experiment.isBlank() && variant != null && !variant.isBlank();
        String filter = Json.write(filtered ? Map.of(experiment, variant) : Map.of());
        return jdbc.sql("""
                SELECT f.id, u.username, f.rating, f.category, f.message, f.path, f.variants::text, f.viewport,
                       f.user_agent, f.created_at
                FROM feedback f LEFT JOIN users u ON u.id = f.user_id
                WHERE f.variants @> ?::jsonb ORDER BY f.created_at DESC LIMIT 200""")
                .param(filter)
                .query((rs, i) -> new FeedbackView(rs.getLong(1), rs.getString(2), rs.getInt(3), rs.getString(4),
                        rs.getString(5), rs.getString(6), readVariants(rs.getString(7)), rs.getString(8),
                        rs.getString(9), rs.getTimestamp(10).toInstant()))
                .list();
    }

    @SuppressWarnings("unchecked")
    private static Map<String, String> readVariants(String json) {
        return Json.read(json, Map.class);
    }

    private void limit(HttpServletRequest http, String bucket, int perMinute) {
        rateLimiter.hit(bucket + "-ip:" + http.getRemoteAddr(), perMinute, Duration.ofMinutes(1));
    }

    private static UUID userIdOrNull() {
        AuthUser me = AuthUser.currentOrNull();
        return me == null ? null : me.id();
    }
}
