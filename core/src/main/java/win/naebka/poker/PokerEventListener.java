package win.naebka.poker;

import java.util.UUID;

/** Observer of a table (LLD: PokerEventListener) — the service uses it to broadcast and persist. */
public interface PokerEventListener {
    void onGameStateChanged(PokerTable table);

    void onPlayerActed(PokerTable table, UUID playerId, PlayerAction action);

    void onHandCompleted(PokerTable table, PokerTable.HandResult result);
}
