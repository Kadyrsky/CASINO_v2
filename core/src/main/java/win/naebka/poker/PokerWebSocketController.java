package win.naebka.poker;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Component;
import win.naebka.common.ErrorCode;
import win.naebka.common.Exceptions.GameStateMismatchException;
import win.naebka.common.Exceptions.NaebkaException;
import win.naebka.ws.NaebkaWebSocketHandler;
import win.naebka.ws.WsClient;
import win.naebka.ws.WsCommandHandler;

/**
 * Poker commands over the WebSocket (LLD: PokerWebSocketController.handleClientAction):
 * {@code {op:"poker.action", tableId, action:"CALL", amount}}, {@code {op:"poker.sync", tableId}},
 * {@code {op:"poker.sitIn"|"poker.sitOut", tableId}}. Amounts are chips in minor units.
 *
 * <p>An out-of-turn action is discarded and answered with an ERROR frame followed by SYNC_GAME_STATE so the
 * client can re-synchronise (LLD: GameStateMismatchException).
 */
@Component
public class PokerWebSocketController implements WsCommandHandler {
    private final PokerService poker;

    public PokerWebSocketController(PokerService poker) {
        this.poker = poker;
    }

    @Override
    public String prefix() {
        return "poker.";
    }

    @Override
    public void handle(WsClient client, String op, JsonNode msg) {
        UUID tableId = UUID.fromString(msg.path("tableId").asText());
        try {
            switch (op) {
                case "poker.action" -> poker.act(client.userId(), tableId, new PlayerAction(
                        PlayerAction.PlayerActionType.valueOf(msg.path("action").asText().toUpperCase()),
                        msg.path("amount").asLong(0)));
                case "poker.sync" -> sync(client, tableId);
                case "poker.sitIn" -> poker.setSittingOut(client.userId(), tableId, false);
                case "poker.sitOut" -> poker.setSittingOut(client.userId(), tableId, true);
                default -> NaebkaWebSocketHandler.sendError(client, ErrorCode.VALIDATION_FAILED, "Unknown op " + op);
            }
        } catch (GameStateMismatchException e) {
            NaebkaWebSocketHandler.sendError(client, e.code(), e.getMessage());
            sync(client, tableId);
        } catch (NaebkaException e) {
            NaebkaWebSocketHandler.sendError(client, e.code(), e.getMessage());
        } catch (IllegalArgumentException e) {
            NaebkaWebSocketHandler.sendError(client, ErrorCode.VALIDATION_FAILED, "Invalid poker command");
        }
    }

    private void sync(WsClient client, UUID tableId) {
        client.send(Map.of("type", "SYNC_GAME_STATE", "topic", PokerService.topic(tableId),
                "data", poker.snapshot(tableId, client.userId())));
    }

    @Override
    public void onUserConnected(UUID userId) {
        poker.userConnected(userId);
    }

    @Override
    public void onUserDisconnected(UUID userId) {
        poker.userDisconnected(userId);
    }
}
