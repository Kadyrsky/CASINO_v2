package win.naebka.poker;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.ArrayList;
import java.util.List;
import java.util.Random;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import win.naebka.common.Exceptions.GameStateMismatchException;
import win.naebka.common.Exceptions.InvalidBetAmountException;

class PokerTableTest {
    PokerTable table;
    List<PokerTable.HandResult> results;
    Player a;
    Player b;
    Player c;

    @BeforeEach
    void setUp() {
        table = new PokerTable(UUID.randomUUID(), "test", 6, 50, 100, 5, 3, new Deck(new Random(42)));
        results = new ArrayList<>();
        table.addListener(new PokerEventListener() {
            public void onGameStateChanged(PokerTable t) {}

            public void onPlayerActed(PokerTable t, UUID id, PlayerAction action) {}

            public void onHandCompleted(PokerTable t, PokerTable.HandResult r) {
                results.add(r);
            }
        });
        a = player("a", 0, 10_000);
        b = player("b", 1, 10_000);
        c = player("c", 2, 10_000);
    }

    Player player(String name, int seat, long stack) {
        return new Player(UUID.randomUUID(), name, seat, stack, "10.0.0." + seat, UUID.randomUUID());
    }

    /** Chips in stacks plus, while a hand runs, chips committed to the pot. */
    long totalChips() {
        long inPot = table.isHandInProgress() ? table.seatedPlayers().stream().mapToLong(Player::getTotalBet).sum() : 0;
        return table.seatedPlayers().stream().mapToLong(Player::getChipStack).sum() + inPot;
    }

    Player toAct() {
        return table.currentPlayer().orElseThrow();
    }

    @Test
    void blindsAndFirstActionThreeHanded() {
        table.addPlayer(a, 0);
        table.addPlayer(b, 1);
        table.addPlayer(c, 2);
        assertThat(table.startHand()).isTrue();
        // dealer = seat 0, SB = seat 1, BB = seat 2, first to act = seat 0 (UTG)
        assertThat(b.getCurrentBet()).isEqualTo(50);
        assertThat(c.getCurrentBet()).isEqualTo(100);
        assertThat(toAct()).isSameAs(a);
        assertThat(a.getHoleCards()).hasSize(2);
        assertThat(table.publicState().get("seats").toString()).contains("HIDDEN").doesNotContain(a.getHoleCards().get(0).toString() + ",");
    }

    @Test
    void outOfTurnActionIsRejected() {
        table.addPlayer(a, 0);
        table.addPlayer(b, 1);
        table.addPlayer(c, 2);
        table.startHand();
        assertThatThrownBy(() -> table.applyAction(b.getId(), PlayerAction.call()))
                .isInstanceOf(GameStateMismatchException.class);
    }

    @Test
    void foldsAroundAwardThePotWithoutRakePreFlop() {
        table.addPlayer(a, 0);
        table.addPlayer(b, 1);
        table.addPlayer(c, 2);
        table.startHand();
        table.applyAction(a.getId(), PlayerAction.fold());
        table.applyAction(b.getId(), PlayerAction.fold());
        assertThat(results).hasSize(1);
        assertThat(results.get(0).rake()).isZero(); // no flop, no drop
        assertThat(c.getChipStack()).isEqualTo(10_050);
        assertThat(totalChips()).isEqualTo(30_000);
    }

    @Test
    void checkedDownHandReachesShowdownAndConservesChips() {
        table.addPlayer(a, 0);
        table.addPlayer(b, 1);
        table.addPlayer(c, 2);
        table.startHand();
        table.applyAction(a.getId(), PlayerAction.call());
        table.applyAction(b.getId(), PlayerAction.call());
        table.applyAction(c.getId(), PlayerAction.check());
        for (BettingRound r : List.of(BettingRound.FLOP, BettingRound.TURN, BettingRound.RIVER)) {
            assertThat(table.getCurrentRound()).isEqualTo(r);
            for (int i = 0; i < 3; i++) {
                table.applyAction(toAct().getId(), PlayerAction.check());
            }
        }
        assertThat(results).hasSize(1);
        PokerTable.HandResult r = results.get(0);
        assertThat(r.showdown()).isTrue();
        assertThat(r.board()).hasSize(5);
        assertThat(r.rake()).isEqualTo(15); // 5% of 300
        assertThat(totalChips() + r.rake()).isEqualTo(30_000);
    }

    @Test
    void minimumRaiseIsEnforced() {
        table.addPlayer(a, 0);
        table.addPlayer(b, 1);
        table.addPlayer(c, 2);
        table.startHand();
        assertThatThrownBy(() -> table.applyAction(a.getId(), PlayerAction.raise(150)))
                .isInstanceOf(InvalidBetAmountException.class);
        table.applyAction(a.getId(), PlayerAction.raise(300));
        assertThat(table.getCurrentHighBet()).isEqualTo(300);
        // next min raise is to 300 + 200
        assertThatThrownBy(() -> table.applyAction(b.getId(), PlayerAction.raise(400)))
                .isInstanceOf(InvalidBetAmountException.class);
        table.applyAction(b.getId(), PlayerAction.raise(500));
        assertThat(table.getCurrentHighBet()).isEqualTo(500);
    }

    @Test
    void raiseReopensActionForPlayersWhoAlreadyActed() {
        table.addPlayer(a, 0);
        table.addPlayer(b, 1);
        table.addPlayer(c, 2);
        table.startHand();
        table.applyAction(a.getId(), PlayerAction.call());
        table.applyAction(b.getId(), PlayerAction.call());
        table.applyAction(c.getId(), PlayerAction.raise(400)); // BB raises
        assertThat(table.getCurrentRound()).isEqualTo(BettingRound.PRE_FLOP);
        assertThat(toAct()).isSameAs(a);
    }

    @Test
    void allInsCreateSidePotsAndRunOutTheBoard() {
        Player shortStack = player("short", 0, 1_000);
        table.addPlayer(shortStack, 0);
        table.addPlayer(b, 1);
        table.addPlayer(c, 2);
        table.startHand();
        table.applyAction(shortStack.getId(), PlayerAction.allIn());
        table.applyAction(b.getId(), PlayerAction.allIn());
        table.applyAction(c.getId(), PlayerAction.call());
        assertThat(results).hasSize(1);
        PokerTable.HandResult r = results.get(0);
        assertThat(r.board()).hasSize(5);
        assertThat(r.contributions().get(shortStack.getId())).isEqualTo(1_000);
        assertThat(r.contributions().get(b.getId())).isEqualTo(10_000);
        // short stack can win at most the main pot: 3 × 1000 minus rake share
        assertThat(r.winnings().getOrDefault(shortStack.getId(), 0L)).isLessThanOrEqualTo(3_000);
        assertThat(table.seatedPlayers().stream().mapToLong(Player::getChipStack).sum() + r.rake()).isEqualTo(21_000);
    }

    @Test
    void sidePotsFollowContributionLevels() {
        Player x = player("x", 0, 0);
        Player y = player("y", 1, 0);
        Player z = player("z", 2, 0);
        for (Player p : List.of(x, y, z)) {
            p.setInHand(true);
            p.setStatus(Player.PlayerStatus.ACTIVE);
        }
        x.addChips(100);
        x.deductChips(100);
        y.addChips(300);
        y.deductChips(300);
        z.addChips(300);
        z.deductChips(300);
        List<Pot> pots = new PotManager().calculateSidePots(List.of(x, y, z));
        assertThat(pots).hasSize(2);
        assertThat(pots.get(0).getAmount()).isEqualTo(300);
        assertThat(pots.get(0).getEligiblePlayerIds()).containsExactlyInAnyOrder(x.getId(), y.getId(), z.getId());
        assertThat(pots.get(1).getAmount()).isEqualTo(400);
        assertThat(pots.get(1).getEligiblePlayerIds()).containsExactlyInAnyOrder(y.getId(), z.getId());
    }

    @Test
    void timeoutChecksWhenFreeOtherwiseFoldsAndSitsOutAfterTwo() {
        table.addPlayer(a, 0);
        table.addPlayer(b, 1);
        table.addPlayer(c, 2);
        table.startHand();
        table.handleTimeout(a.getId()); // facing the big blind: fold
        assertThat(a.getStatus()).isEqualTo(Player.PlayerStatus.FOLDED);
        table.applyAction(b.getId(), PlayerAction.call());
        table.handleTimeout(c.getId()); // big blind with nothing to call: check
        assertThat(c.getStatus()).isEqualTo(Player.PlayerStatus.ACTIVE);
        assertThat(table.getCurrentRound()).isEqualTo(BettingRound.FLOP);
    }

    @Test
    void headsUpButtonPostsSmallBlindAndActsFirst() {
        table.addPlayer(a, 0);
        table.addPlayer(b, 3);
        table.startHand();
        assertThat(a.getCurrentBet()).isEqualTo(50);
        assertThat(b.getCurrentBet()).isEqualTo(100);
        assertThat(toAct()).isSameAs(a);
    }

    @Test
    void leavingMidHandFoldsAndRemovesAfterTheHand() {
        table.addPlayer(a, 0);
        table.addPlayer(b, 1);
        table.addPlayer(c, 2);
        table.startHand();
        assertThat(table.removePlayer(b.getId())).isEmpty(); // not their turn: folds, stays until hand ends
        assertThat(b.getStatus()).isEqualTo(Player.PlayerStatus.FOLDED);
        table.applyAction(a.getId(), PlayerAction.fold());
        assertThat(results).hasSize(1);
        assertThat(table.collectLeavers()).containsExactly(b);
        assertThat(table.seatedCount()).isEqualTo(2);
    }

    @Test
    void dealerButtonMovesEachHand() {
        table.addPlayer(a, 0);
        table.addPlayer(b, 1);
        table.addPlayer(c, 2);
        table.startHand();
        table.applyAction(a.getId(), PlayerAction.fold());
        table.applyAction(b.getId(), PlayerAction.fold());
        table.startHand();
        // dealer = seat 1, SB = seat 2, BB = seat 0, first to act = seat 1
        assertThat(toAct()).isSameAs(b);
        assertThat(c.getCurrentBet()).isEqualTo(50);
        assertThat(a.getCurrentBet()).isEqualTo(100);
    }
}
