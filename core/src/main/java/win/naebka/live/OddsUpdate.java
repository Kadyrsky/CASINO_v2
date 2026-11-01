package win.naebka.live;

import com.fasterxml.jackson.databind.JsonNode;
import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** A batch of prices from the Odds Engine for one match. */
public record OddsUpdate(String externalMatchId, String basedOnEventId, List<MarketPrice> markets) {

    /** odds: outcome_key → decimal odds. {@code close} = the outcome is decided, stop taking bets. */
    public record MarketPrice(String marketType, Map<String, BigDecimal> odds, boolean close) {}

    public static OddsUpdate from(JsonNode node) {
        List<MarketPrice> markets = new ArrayList<>();
        for (JsonNode m : node.path("markets")) {
            Map<String, BigDecimal> odds = new LinkedHashMap<>();
            m.path("odds").fields().forEachRemaining(e -> odds.put(e.getKey(), e.getValue().decimalValue()));
            markets.add(new MarketPrice(m.path("market_type").asText(), odds, m.path("close").asBoolean(false)));
        }
        return new OddsUpdate(node.path("match_id").asText(), node.path("based_on_event_id").asText(null), markets);
    }
}
