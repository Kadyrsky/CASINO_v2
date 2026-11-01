package win.naebka.poker;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Arrays;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

class HandEvaluatorTest {

    static List<Card> cards(String s) {
        return Arrays.stream(s.split(" ")).map(Card::parse).toList();
    }

    static HandEvaluation eval(String hole, String board) {
        return HandEvaluator.evaluate(cards(hole), cards(board));
    }

    @ParameterizedTest
    @CsvSource({
            "As Ks, Qs Js Ts 2d 3c, ROYAL_FLUSH",
            "9h 8h, 7h 6h 5h Ad Ac, STRAIGHT_FLUSH",
            "Ac 2c, 3c 4c 5c Kd Kh, STRAIGHT_FLUSH",
            "Qd Qh, Qs Qc 2d 3c 4h, FOUR_OF_A_KIND",
            "Kd Kh, Ks 2c 2d 3c 4h, FULL_HOUSE",
            "Ad 9d, 2d 5d Jd Kc Kh, FLUSH",
            "Ad 2c, 3h 4s 5d Kc Qh, STRAIGHT",
            "Td Jc, Qh Ks Ad 2c 3h, STRAIGHT",
            "7d 7c, 7h Ks Ad 2c 3h, THREE_OF_A_KIND",
            "7d 7c, Kh Ks Ad 2c 3h, TWO_PAIR",
            "7d 7c, 9h Ks Ad 2c 3h, ONE_PAIR",
            "7d 8c, 9h Ks Ad 2c 3h, HIGH_CARD"
    })
    void recognisesEveryCategory(String hole, String board, HandRank expected) {
        assertThat(eval(hole, board).handRank()).isEqualTo(expected);
    }

    @Test
    void wheelIsTheLowestStraight() {
        HandEvaluation wheel = eval("Ad 2c", "3h 4s 5d Kc Qh");
        HandEvaluation six = eval("6d 2c", "3h 4s 5d Kc Qh");
        assertThat(six).isGreaterThan(wheel);
    }

    @Test
    void kickersBreakTies() {
        HandEvaluation aceKicker = eval("Kd Ac", "Kh 7s 5d 3c 2h");
        HandEvaluation queenKicker = eval("Ks Qc", "Kh 7s 5d 3c 2h");
        assertThat(aceKicker).isGreaterThan(queenKicker);
    }

    @Test
    void twoPairComparesHigherPairThenLowerPairThenKicker() {
        assertThat(eval("Ac Ad", "Kh Ks 2c 3d 9h")).isGreaterThan(eval("Qc Qd", "Kh Ks 2c 3d 9h"));
        assertThat(eval("Ac 2s", "Ah Ks Kc 2d 9h")).isGreaterThan(eval("Ad Qs", "Ah Ks Kc 3d 9h").handRank() == HandRank.TWO_PAIR
                ? eval("Ad 3s", "Ah Ks Kc 2d 8h") : eval("Ad Qs", "Ah Ks Kc 3d 9h"));
    }

    @Test
    void boardPlaysForBothIsATie() {
        assertThat(eval("2c 3d", "Ah Kh Qh Jh Th").compareTo(eval("4c 5d", "Ah Kh Qh Jh Th"))).isZero();
    }

    @Test
    void fullHouseRanksByTripsFirst() {
        assertThat(eval("3c 3d", "3h 2s 2c Kd Qh")).isLessThan(eval("Kc Ks", "Kh 2s 2c 7d 8h"));
    }
}
