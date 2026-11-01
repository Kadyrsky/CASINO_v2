package win.naebka.eth;

import com.fasterxml.jackson.databind.JsonNode;
import java.security.SecureRandom;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import win.naebka.common.ErrorCode;
import win.naebka.common.Exceptions.DomainException;
import win.naebka.common.Json;
import win.naebka.common.TxRetry;
import win.naebka.config.NaebkaProperties;

/**
 * Links an Ethereum address to an account. The player proves they hold the key by signing a one-time
 * Sign-In with Ethereum (EIP-4361) message in MetaMask; the server never trusts an address the browser reports.
 * The message names a fixed domain, so MetaMask warns if another site asks the player to sign it.
 */
@Service
public class EthLinkService {
    private static final String ALPHANUMERIC = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
    private static final SecureRandom RANDOM = new SecureRandom();

    private final StringRedisTemplate redis;
    private final JdbcClient jdbc;
    private final TxRetry tx;
    private final EthDepositService deposits;
    private final NaebkaProperties props;

    public EthLinkService(StringRedisTemplate redis, JdbcClient jdbc, TxRetry tx, EthDepositService deposits,
                          NaebkaProperties props) {
        this.redis = redis;
        this.jdbc = jdbc;
        this.tx = tx;
        this.deposits = deposits;
        this.props = props;
    }

    /** Creates the message to sign for {@code address} and remembers it for this user until it expires. */
    public String createLinkMessage(UUID userId, String username, String address) {
        var eth = requireConfigured();
        String normalized = Eth.normalize(address);
        Instant now = Instant.now().truncatedTo(ChronoUnit.SECONDS);
        String message = buildMessage(eth.siweDomain(), eth.siweUri(), Eth.checksum(normalized), username,
                eth.chainId(), nonce(), now, now.plusSeconds(eth.linkMessageTtlSeconds()));
        redis.opsForValue().set(key(userId), Json.write(Map.of("address", normalized, "message", message)),
                Duration.ofSeconds(eth.linkMessageTtlSeconds()));
        return message;
    }

    /** Verifies the signature over the stored message and links the address. Returns the linked address. */
    public String link(UUID userId, String signature) {
        var eth = requireConfigured();
        String stored = redis.opsForValue().getAndDelete(key(userId)); // one attempt per message
        if (stored == null) {
            throw new DomainException(ErrorCode.LINK_MESSAGE_EXPIRED, "The sign-in message expired. Start again.");
        }
        JsonNode pending = Json.read(stored);
        String address = pending.path("address").asText();
        String signer = Eth.recoverPersonalSign(pending.path("message").asText(), signature);
        if (!signer.equals(address)) {
            throw new DomainException(ErrorCode.INVALID_SIGNATURE,
                    "The message was signed by a different account than the one you are linking. Check MetaMask.");
        }
        try {
            return tx.inTransaction(() -> {
                Optional<UUID> owner = jdbc.sql("SELECT user_id FROM wallet_addresses WHERE chain_id = ? AND address = ?")
                        .params(eth.chainId(), address).query(UUID.class).optional();
                if (owner.isPresent() && !owner.get().equals(userId)) {
                    throw addressTaken();
                }
                jdbc.sql("DELETE FROM wallet_addresses WHERE user_id = ?").param(userId).update();
                jdbc.sql("INSERT INTO wallet_addresses (user_id, chain_id, address) VALUES (?, ?, ?)")
                        .params(userId, eth.chainId(), address).update();
                deposits.creditUnlinkedFrom(address);
                return address;
            });
        } catch (DuplicateKeyException e) {
            throw addressTaken(); // another account linked it at the same moment
        }
    }

    public void unlink(UUID userId) {
        jdbc.sql("DELETE FROM wallet_addresses WHERE user_id = ?").param(userId).update();
    }

    public Optional<String> linkedAddress(UUID userId) {
        return jdbc.sql("SELECT address FROM wallet_addresses WHERE user_id = ? AND chain_id = ?")
                .params(userId, props.eth().chainId()).query(String.class).optional();
    }

    /** EIP-4361 text. MetaMask recognises this format and checks the domain against the page it is shown on. */
    static String buildMessage(String domain, String uri, String checksumAddress, String username, long chainId,
                               String nonce, Instant issuedAt, Instant expiresAt) {
        return domain + " wants you to sign in with your Ethereum account:\n"
                + checksumAddress + "\n\n"
                + "Link this address to the Naebka account \"" + username.replaceAll("[^A-Za-z0-9_.-]", "")
                + "\". Sepolia test ETH only: it has no value.\n\n"
                + "URI: " + uri + "\n"
                + "Version: 1\n"
                + "Chain ID: " + chainId + "\n"
                + "Nonce: " + nonce + "\n"
                + "Issued At: " + issuedAt + "\n"
                + "Expiration Time: " + expiresAt;
    }

    private NaebkaProperties.Eth requireConfigured() {
        if (!props.eth().configured()) {
            throw new DomainException(ErrorCode.ETH_NOT_CONFIGURED,
                    "Sepolia deposits are off: the cashier contract address is not configured");
        }
        return props.eth();
    }

    private static String nonce() {
        StringBuilder sb = new StringBuilder(16);
        for (int i = 0; i < 16; i++) {
            sb.append(ALPHANUMERIC.charAt(RANDOM.nextInt(ALPHANUMERIC.length())));
        }
        return sb.toString();
    }

    private static String key(UUID userId) {
        return "naebka:eth-link:" + userId;
    }

    private static DomainException addressTaken() {
        return new DomainException(ErrorCode.ADDRESS_TAKEN, "This address is already linked to another account");
    }
}
