package win.naebka.ab;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.sql.Array;
import java.sql.SQLException;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.RowCallbackHandler;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import win.naebka.auth.AuthUser;
import win.naebka.common.ErrorCode;
import win.naebka.common.Exceptions;
import win.naebka.common.Json;
import win.naebka.common.RateLimiter;

/**
 * A/B experiments, the taste test and site feedback. The experiments themselves (names, variants, how a visitor is
 * assigned) live in the frontend (src/lib/experiments.ts); the core only stores what visitors saw, switched to,
 * answered and did, and sums it up for the admin dashboard (docs/ab-testing.md). The write endpoints are public so
 * anonymous visitors count. They are rate-limited per visitor, with a looser limit per IP address, because on a
 * test day a whole classroom may share one address.
 */
@RestController
public class AbController {
    /** Experiment, variant, goal and tag names: short snake_case words. */
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

    /** source: "customize" (the Customize panel, the default) or "taste_test" (a version picked in the taste test). */
    public record SwitchRequest(@NotNull UUID visitorId, @NotNull @Pattern(regexp = NAME) String experiment,
                                @NotNull @Pattern(regexp = NAME) String assigned,
                                @NotNull @Pattern(regexp = NAME) String from, @NotNull @Pattern(regexp = NAME) String to,
                                @Pattern(regexp = "^(customize|taste_test)$") String source) {}

    public record GoalRequest(@NotNull UUID visitorId, @NotNull @Pattern(regexp = NAME) String goal) {}

    /** One taste-test answer: the two versions as shown (left, right) and the one picked (null: no preference). */
    public record VoteRequest(@NotNull UUID visitorId, @NotNull @Pattern(regexp = NAME) String experiment,
                              @NotNull @Pattern(regexp = NAME) String left, @NotNull @Pattern(regexp = NAME) String right,
                              @Pattern(regexp = NAME) String winner, boolean previewedBoth,
                              @Min(0) @Max(3_600_000) Integer decisionMs) {}

    public record FeedbackRequest(@NotNull UUID visitorId, @NotNull @Min(1) @Max(5) Integer rating,
                                  @NotNull @Pattern(regexp = "^(ui|bug|idea|other|general)$") String category,
                                  @Size(max = 2000) String message, @NotNull @Size(max = 200) String path,
                                  @Size(max = 20) Map<@Pattern(regexp = NAME) String, @Pattern(regexp = NAME) String> variants,
                                  @Size(max = 40) String viewport,
                                  @Pattern(regexp = "^(button|pulse|taste_test)$") String source,
                                  @Size(max = 10) List<@Pattern(regexp = NAME) String> tags) {}

    /** The reasons and comment added after a one-tap rating. */
    public record FeedbackDetails(@NotNull UUID visitorId, @Size(max = 10) List<@Pattern(regexp = NAME) String> tags,
                                  @Size(max = 2000) String message) {}

    public record Created(long id) {}

    /** What a logged-in player picked on other devices, so their versions follow them. */
    public record Mine(UUID visitorId, Map<String, String> choices) {}

    /** Records which version of each experiment the visitor is seeing (and links them to their account if logged in). */
    @PostMapping("/api/ab/assignments")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    @Transactional
    public void assignments(@Valid @RequestBody AssignmentsRequest req, HttpServletRequest http) {
        limit(http, req.visitorId(), "ab", 60, 1200);
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

    /** Someone changed a version by hand under Customize, or by picking it in the taste test. */
    @PostMapping("/api/ab/switches")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    @Transactional
    public void switched(@Valid @RequestBody SwitchRequest req, HttpServletRequest http) {
        limit(http, req.visitorId(), "ab", 60, 1200);
        if (req.from().equals(req.to())) {
            return;
        }
        jdbc.sql("INSERT INTO ab_switches (visitor_id, experiment, from_variant, to_variant, source) VALUES (?, ?, ?, ?, ?)")
                .params(req.visitorId(), req.experiment(), req.from(), req.to(),
                        req.source() == null ? "customize" : req.source()).update();
        jdbc.sql("""
                INSERT INTO ab_assignments (visitor_id, experiment, assigned_variant, current_variant, user_id)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT (visitor_id, experiment) DO UPDATE
                SET current_variant = excluded.current_variant,
                    user_id = coalesce(excluded.user_id, ab_assignments.user_id),
                    updated_at = now()""")
                .params(req.visitorId(), req.experiment(), req.assigned(), req.to(), userIdOrNull()).update();
    }

    /** A goal reached (registered, bet_placed, music_off, ...); only the first time per visitor counts. */
    @PostMapping("/api/ab/goals")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void goal(@Valid @RequestBody GoalRequest req, HttpServletRequest http) {
        limit(http, req.visitorId(), "ab", 60, 1200);
        jdbc.sql("INSERT INTO ab_goals (visitor_id, goal) VALUES (?, ?) ON CONFLICT DO NOTHING")
                .params(req.visitorId(), req.goal()).update();
    }

    /** A taste-test answer. Answering the same pair again replaces the earlier answer. */
    @PostMapping("/api/ab/votes")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void vote(@Valid @RequestBody VoteRequest req, HttpServletRequest http) {
        limit(http, req.visitorId(), "ab", 60, 1200);
        if (req.left().equals(req.right())
                || req.winner() != null && !req.winner().equals(req.left()) && !req.winner().equals(req.right())) {
            throw new Exceptions.DomainException(ErrorCode.VALIDATION_FAILED, "The winner must be one of the two versions");
        }
        boolean leftFirst = req.left().compareTo(req.right()) < 0;
        jdbc.sql("""
                INSERT INTO ab_votes (visitor_id, user_id, experiment, variant_a, variant_b, left_variant, winner,
                                      previewed_both, decision_ms)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (visitor_id, experiment, variant_a, variant_b) DO UPDATE
                SET left_variant = excluded.left_variant, winner = excluded.winner,
                    previewed_both = excluded.previewed_both, decision_ms = excluded.decision_ms, created_at = now()""")
                .params(req.visitorId(), userIdOrNull(), req.experiment(), leftFirst ? req.left() : req.right(),
                        leftFirst ? req.right() : req.left(), req.left(), req.winner(), req.previewedBoth(),
                        req.decisionMs())
                .update();
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
    public Created feedback(@Valid @RequestBody FeedbackRequest req, HttpServletRequest http) {
        limit(http, req.visitorId(), "feedback", 6, 120);
        String message = req.message() == null || req.message().isBlank() ? null : req.message().strip();
        String agent = http.getHeader("User-Agent");
        long id = jdbc.sql("""
                INSERT INTO feedback (visitor_id, user_id, rating, category, message, path, variants, viewport, user_agent,
                                      source, tags)
                VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?::text[]) RETURNING id""")
                .params(req.visitorId(), userIdOrNull(), req.rating(), req.category(), message, req.path(),
                        Json.write(req.variants() == null ? Map.of() : req.variants()), req.viewport(),
                        agent == null ? null : agent.substring(0, Math.min(agent.length(), 300)),
                        req.source() == null ? "button" : req.source(), pgArray(req.tags()))
                .query(Long.class).single();
        return new Created(id);
    }

    /** Adds reasons and a comment to a rating the same visitor sent in the last hour. */
    @PostMapping("/api/feedback/{id}/details")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void feedbackDetails(@PathVariable long id, @Valid @RequestBody FeedbackDetails req, HttpServletRequest http) {
        limit(http, req.visitorId(), "feedback", 6, 120);
        String message = req.message() == null || req.message().isBlank() ? null : req.message().strip();
        int updated = jdbc.sql("""
                UPDATE feedback SET tags = ?::text[], message = coalesce(?, message)
                WHERE id = ? AND visitor_id = ? AND created_at > now() - interval '1 hour'""")
                .params(pgArray(req.tags()), message, id, req.visitorId()).update();
        if (updated == 0) {
            throw new Exceptions.DomainException(ErrorCode.NOT_FOUND, "No recent feedback with that id from this visitor");
        }
    }

    // ---- Admin dashboard ----

    /**
     * switchedAway: visitors who moved away from the version they were given, by hand under Customize (people who
     * don't like it). pickedInTasteTest: visitors whose version changed through a taste-test answer instead.
     */
    public record VariantResult(String variant, long visitors, long switchedAway, long pickedInTasteTest, long onItNow,
                                Map<String, Long> goals, Double avgRating, long ratings) {}

    public record SwitchFlow(String from, String to, String source, long count) {}

    public record ExperimentResult(String experiment, List<VariantResult> variants, List<SwitchFlow> switches) {}

    @GetMapping("/api/admin/ab/results")
    public List<ExperimentResult> results() {
        Map<String, Map<String, long[]>> counts = new LinkedHashMap<>();
        // Per assigned variant: visitors, how many left it by hand, and how many changed it in the taste test.
        jdbc.sql("""
                SELECT a.experiment, a.assigned_variant, count(*),
                       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM ab_switches s WHERE s.visitor_id = a.visitor_id
                           AND s.experiment = a.experiment AND s.source = 'customize' AND s.from_variant = a.assigned_variant)),
                       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM ab_switches s WHERE s.visitor_id = a.visitor_id
                           AND s.experiment = a.experiment AND s.source = 'taste_test'))
                FROM ab_assignments a GROUP BY 1, 2 ORDER BY 1, 2""")
                .query((RowCallbackHandler) rs -> counts.computeIfAbsent(rs.getString(1), k -> new LinkedHashMap<>())
                        .put(rs.getString(2), new long[] {rs.getLong(3), rs.getLong(4), rs.getLong(5), 0}));
        // Per current variant: how many are on it now (people who kept it plus people who switched to it).
        jdbc.sql("SELECT experiment, current_variant, count(*) FROM ab_assignments GROUP BY 1, 2")
                .query((RowCallbackHandler) rs -> counts.computeIfAbsent(rs.getString(1), k -> new LinkedHashMap<>())
                        .computeIfAbsent(rs.getString(2), k -> new long[4])[3] = rs.getLong(3));

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
                SELECT experiment, from_variant, to_variant, source, count(*) FROM ab_switches
                GROUP BY 1, 2, 3, 4 ORDER BY 5 DESC""")
                .query((RowCallbackHandler) rs -> flows.computeIfAbsent(rs.getString(1), k -> new ArrayList<>())
                        .add(new SwitchFlow(rs.getString(2), rs.getString(3), rs.getString(4), rs.getLong(5))));

        return counts.entrySet().stream().map(e -> new ExperimentResult(e.getKey(),
                e.getValue().entrySet().stream().map(v -> {
                    String key = e.getKey() + "/" + v.getKey();
                    double[] r = ratings.get(key);
                    long[] c = v.getValue();
                    return new VariantResult(v.getKey(), c[0], c[1], c[2], c[3], goals.getOrDefault(key, Map.of()),
                            r == null ? null : r[0], r == null ? 0 : (long) r[1]);
                }).toList(),
                flows.getOrDefault(e.getKey(), List.of()))).toList();
    }

    public record VoteView(String experiment, String variantA, String variantB, String left, String winner,
                           boolean previewedBoth, Integer decisionMs, UUID visitorId, Instant createdAt) {}

    /** Every taste-test answer; the dashboard ranks the versions from them (and exports them as CSV). */
    @GetMapping("/api/admin/ab/votes")
    public List<VoteView> votes() {
        return jdbc.sql("""
                SELECT experiment, variant_a, variant_b, left_variant, winner, previewed_both, decision_ms, visitor_id,
                       created_at
                FROM ab_votes ORDER BY created_at LIMIT 20000""")
                .query((rs, i) -> new VoteView(rs.getString(1), rs.getString(2), rs.getString(3), rs.getString(4),
                        rs.getString(5), rs.getBoolean(6), (Integer) rs.getObject(7), rs.getObject(8, UUID.class),
                        rs.getTimestamp(9).toInstant()))
                .list();
    }

    /** One row per visitor, for analysing the raw data elsewhere (the dashboard's CSV export). */
    public record VisitorRow(UUID visitorId, boolean registered, Instant firstSeen, Map<String, String> assigned,
                             Map<String, String> current, List<String> goals, long switchesByHand,
                             long tasteTestAnswers) {}

    @GetMapping("/api/admin/ab/visitors")
    public List<VisitorRow> visitors() {
        Map<UUID, Object[]> rows = new LinkedHashMap<>();
        jdbc.sql("""
                SELECT visitor_id, bool_or(user_id IS NOT NULL), min(first_seen),
                       jsonb_object_agg(experiment, assigned_variant)::text, jsonb_object_agg(experiment, current_variant)::text
                FROM ab_assignments GROUP BY visitor_id ORDER BY min(first_seen) LIMIT 20000""")
                .query((RowCallbackHandler) rs -> rows.put(rs.getObject(1, UUID.class), new Object[] {
                        rs.getBoolean(2), rs.getTimestamp(3).toInstant(), readVariants(rs.getString(4)),
                        readVariants(rs.getString(5)), new TreeSet<String>(), new long[2]}));
        jdbc.sql("SELECT visitor_id, goal FROM ab_goals").query((RowCallbackHandler) rs -> {
            Object[] row = rows.get(rs.getObject(1, UUID.class));
            if (row != null) {
                @SuppressWarnings("unchecked")
                TreeSet<String> g = (TreeSet<String>) row[4];
                g.add(rs.getString(2));
            }
        });
        jdbc.sql("""
                SELECT visitor_id, count(*) FILTER (WHERE source = 'customize'), 0 FROM ab_switches GROUP BY 1
                UNION ALL SELECT visitor_id, 0, count(*) FROM ab_votes GROUP BY 1""")
                .query((RowCallbackHandler) rs -> {
                    Object[] row = rows.get(rs.getObject(1, UUID.class));
                    if (row != null) {
                        long[] n = (long[]) row[5];
                        n[0] += rs.getLong(2);
                        n[1] += rs.getLong(3);
                    }
                });
        return rows.entrySet().stream().map(e -> {
            Object[] r = e.getValue();
            @SuppressWarnings("unchecked")
            Map<String, String> assigned = (Map<String, String>) r[2];
            @SuppressWarnings("unchecked")
            Map<String, String> current = (Map<String, String>) r[3];
            @SuppressWarnings("unchecked")
            TreeSet<String> g = (TreeSet<String>) r[4];
            long[] n = (long[]) r[5];
            return new VisitorRow(e.getKey(), (Boolean) r[0], (Instant) r[1], assigned, current, List.copyOf(g), n[0], n[1]);
        }).toList();
    }

    public record FeedbackView(long id, String username, int rating, String category, String message, String path,
                               Map<String, String> variants, String viewport, String userAgent, String source,
                               List<String> tags, Instant createdAt) {}

    @GetMapping("/api/admin/feedback")
    public List<FeedbackView> feedbackList(@RequestParam(required = false) String experiment,
                                           @RequestParam(required = false) String variant) {
        boolean filtered = experiment != null && !experiment.isBlank() && variant != null && !variant.isBlank();
        String filter = Json.write(filtered ? Map.of(experiment, variant) : Map.of());
        return jdbc.sql("""
                SELECT f.id, u.username, f.rating, f.category, f.message, f.path, f.variants::text, f.viewport,
                       f.user_agent, f.source, f.tags, f.created_at
                FROM feedback f LEFT JOIN users u ON u.id = f.user_id
                WHERE f.variants @> ?::jsonb ORDER BY f.created_at DESC LIMIT 1000""")
                .param(filter)
                .query((rs, i) -> new FeedbackView(rs.getLong(1), rs.getString(2), rs.getInt(3), rs.getString(4),
                        rs.getString(5), rs.getString(6), readVariants(rs.getString(7)), rs.getString(8),
                        rs.getString(9), rs.getString(10), strings(rs.getArray(11)), rs.getTimestamp(12).toInstant()))
                .list();
    }

    @SuppressWarnings("unchecked")
    private static Map<String, String> readVariants(String json) {
        return Json.read(json, Map.class);
    }

    private static List<String> strings(Array array) throws SQLException {
        return array == null ? List.of() : List.of((String[]) array.getArray());
    }

    /** A Postgres array literal; the names are checked against NAME, so they need no quoting. */
    private static String pgArray(List<String> values) {
        return values == null ? "{}" : "{" + String.join(",", new TreeSet<>(values)) + "}";
    }

    private void limit(HttpServletRequest http, UUID visitorId, String bucket, int perVisitor, int perIp) {
        rateLimiter.hit(bucket + "-visitor:" + visitorId, perVisitor, Duration.ofMinutes(1));
        rateLimiter.hit(bucket + "-ip:" + http.getRemoteAddr(), perIp, Duration.ofMinutes(1));
    }

    private static UUID userIdOrNull() {
        AuthUser me = AuthUser.currentOrNull();
        return me == null ? null : me.id();
    }
}
