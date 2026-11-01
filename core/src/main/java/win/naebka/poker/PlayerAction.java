package win.naebka.poker;

/**
 * A decision. For BET and RAISE, {@code amount} is the total the player wants in front of them this round
 * ("raise to"); for the other types it is ignored. ALL_IN commits the whole stack.
 */
public record PlayerAction(PlayerActionType type, long amount) {

    public enum PlayerActionType { FOLD, CHECK, CALL, BET, RAISE, ALL_IN }

    public static PlayerAction fold() {
        return new PlayerAction(PlayerActionType.FOLD, 0);
    }

    public static PlayerAction check() {
        return new PlayerAction(PlayerActionType.CHECK, 0);
    }

    public static PlayerAction call() {
        return new PlayerAction(PlayerActionType.CALL, 0);
    }

    public static PlayerAction bet(long to) {
        return new PlayerAction(PlayerActionType.BET, to);
    }

    public static PlayerAction raise(long to) {
        return new PlayerAction(PlayerActionType.RAISE, to);
    }

    public static PlayerAction allIn() {
        return new PlayerAction(PlayerActionType.ALL_IN, 0);
    }
}
