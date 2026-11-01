package win.naebka.common;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class MoneyAndCursorTest {

    @Test
    void tokensConvertToMinorUnits() {
        assertThat(Money.toMinor(new BigDecimal("12.5"))).isEqualTo(1250);
        assertThat(Money.toMinor(new BigDecimal("12.50"))).isEqualTo(1250);
        assertThat(Money.toTokens(1250)).isEqualByComparingTo("12.50");
    }

    @Test
    void moreThanTwoDecimalsIsRejected() {
        assertThatThrownBy(() -> Money.toMinor(new BigDecimal("1.005"))).isInstanceOf(Exceptions.DomainException.class);
    }

    @Test
    void payoutRoundsDownInTheHousesFavour() {
        assertThat(Money.payout(333, new BigDecimal("1.85"))).isEqualTo(616); // 616.05
        assertThat(Money.payout(1000, new BigDecimal("2.00"))).isEqualTo(2000);
    }

    @Test
    void cursorRoundTrips() {
        Cursor c = new Cursor(Instant.parse("2026-10-25T12:00:00.123456Z"), UUID.randomUUID());
        assertThat(Cursor.decode(c.encode())).isEqualTo(c);
    }

    @Test
    void pageDetectsNextPage() {
        List<Integer> rows = List.of(1, 2, 3);
        Cursor.Page<Integer> page = Cursor.Page.of(rows, 2, i -> new Cursor(Instant.EPOCH, new UUID(0, i)));
        assertThat(page.items()).containsExactly(1, 2);
        assertThat(page.nextCursor()).isNotNull();
        assertThat(Cursor.Page.of(List.of(1), 2, i -> null).nextCursor()).isNull();
    }
}
