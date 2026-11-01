package win.naebka.slots;

import java.nio.charset.StandardCharsets;
import java.security.InvalidKeyException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.HexFormat;
import java.util.List;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * Provably fair randomness. Before playing, the player sees SHA-256(serverSeed); every outcome is derived
 * from HMAC-SHA256(serverSeed, "clientSeed:nonce:round"), so once the server seed is revealed (on rotation)
 * the player can recompute every past result and check nothing was changed.
 *
 * <p>Each HMAC yields 8 floats (4 bytes each → [0, 1)); {@code round} increments when more are needed.
 */
public record ProvablyFairRNG(String serverSeed, String clientSeed, long nonce) {
    private static final SecureRandom SECURE = new SecureRandom();

    public static String newServerSeed() {
        byte[] b = new byte[32];
        SECURE.nextBytes(b);
        return HexFormat.of().formatHex(b);
    }

    public static String newClientSeed() {
        byte[] b = new byte[8];
        SECURE.nextBytes(b);
        return HexFormat.of().formatHex(b);
    }

    public static String sha256(String value) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    static byte[] hmac(String key, String message) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(key.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            return mac.doFinal(message.getBytes(StandardCharsets.UTF_8));
        } catch (NoSuchAlgorithmException | InvalidKeyException e) {
            throw new IllegalStateException(e);
        }
    }

    /** Public commitment of this round: HMAC(serverSeed, clientSeed:nonce) in hex. */
    public String hmacHash() {
        return HexFormat.of().formatHex(hmac(serverSeed, clientSeed + ":" + nonce));
    }

    public double[] floats(int count) {
        double[] out = new double[count];
        int i = 0;
        for (int round = 0; i < count; round++) {
            byte[] h = hmac(serverSeed, clientSeed + ":" + nonce + ":" + round);
            for (int off = 0; off + 4 <= h.length && i < count; off += 4) {
                long v = ((h[off] & 0xFFL) << 24) | ((h[off + 1] & 0xFFL) << 16) | ((h[off + 2] & 0xFFL) << 8) | (h[off + 3] & 0xFFL);
                out[i++] = v / 4294967296.0;
            }
        }
        return out;
    }

    /** Reel stop for each reel, from the first {@code reels.size()} floats. */
    public int[] generateStops(List<Reel> reels) {
        double[] f = floats(reels.size());
        int[] stops = new int[reels.size()];
        for (int c = 0; c < stops.length; c++) {
            stops[c] = reels.get(c).stopFor(f[c]);
        }
        return stops;
    }

    public Symbol[][] generateSpinMatrix(int rows, List<Reel> reels) {
        return matrixFor(generateStops(reels), rows, reels);
    }

    public static Symbol[][] matrixFor(int[] stops, int rows, List<Reel> reels) {
        Symbol[][] grid = new Symbol[reels.size()][];
        for (int c = 0; c < reels.size(); c++) {
            grid[c] = reels.get(c).window(stops[c], rows);
        }
        return grid;
    }

    /** Independently recomputes the matrix for the given seeds and compares it symbol by symbol. */
    public static boolean verifyResult(String serverSeed, String clientSeed, long nonce, Symbol[][] matrix, int rows,
                                       List<Reel> reels) {
        Symbol[][] expected = new ProvablyFairRNG(serverSeed, clientSeed, nonce).generateSpinMatrix(rows, reels);
        if (expected.length != matrix.length) {
            return false;
        }
        for (int c = 0; c < expected.length; c++) {
            for (int r = 0; r < rows; r++) {
                if (!expected[c][r].id().equals(matrix[c][r].id())) {
                    return false;
                }
            }
        }
        return true;
    }
}
