package win.naebka.eth;

import com.fasterxml.jackson.databind.JsonNode;
import java.io.IOException;
import java.math.BigInteger;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;
import org.springframework.stereotype.Component;
import org.web3j.utils.Numeric;
import win.naebka.common.Json;
import win.naebka.config.NaebkaProperties;

/**
 * Minimal Ethereum JSON-RPC client over java.net.http. The browser talks to the chain through MetaMask; the deposit
 * poller reads logs with this, and the payout sender sends the operator's signed payout transactions.
 */
@Component
public class EthRpcClient {
    /** One Deposited event from NaebkaCashier. */
    public record ChainDeposit(String txHash, int logIndex, long blockNumber, String from, BigInteger amountWei) {}

    /** A mined transaction: {@code success} is false when it reverted. */
    public record Receipt(boolean success, long blockNumber) {}

    /** The node could not be reached or answered badly. Whatever was sent may or may not have arrived. */
    public static class RpcException extends RuntimeException {
        public RpcException(String message) {
            super(message);
        }
    }

    /** The node answered with a JSON-RPC error: it refused the request (for a call or estimate, often a revert). */
    public static class RpcRejected extends RpcException {
        private final String data;

        public RpcRejected(String message, String data) {
            super(message);
            this.data = data;
        }

        /** Revert data (an error selector) when the node sent it, else null. */
        public String data() {
            return data;
        }
    }

    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
    private final AtomicLong ids = new AtomicLong();
    private final NaebkaProperties props;

    public EthRpcClient(NaebkaProperties props) {
        this.props = props;
    }

    public long blockNumber() {
        return Numeric.decodeQuantity(call("eth_blockNumber", List.of()).asText()).longValueExact();
    }

    public long chainId() {
        return Numeric.decodeQuantity(call("eth_chainId", List.of()).asText()).longValueExact();
    }

    /** The account's next nonce, counting transactions still waiting in the node's pool. */
    public BigInteger pendingNonce(String address) {
        return Numeric.decodeQuantity(call("eth_getTransactionCount", List.of(address, "pending")).asText());
    }

    public BigInteger balance(String address) {
        return Numeric.decodeQuantity(call("eth_getBalance", List.of(address, "latest")).asText());
    }

    /** Base fee of the latest block (EIP-1559). */
    public BigInteger baseFee() {
        JsonNode block = call("eth_getBlockByNumber", List.of("latest", false));
        String fee = block.path("baseFeePerGas").asText("");
        if (fee.isEmpty()) {
            throw new RpcException("latest block has no baseFeePerGas");
        }
        return Numeric.decodeQuantity(fee);
    }

    public BigInteger maxPriorityFee() {
        return Numeric.decodeQuantity(call("eth_maxPriorityFeePerGas", List.of()).asText());
    }

    /** Gas the call would use. Throws {@link RpcRejected} (with the revert data) when it would revert. */
    public BigInteger estimateGas(String from, String to, String data) {
        return Numeric.decodeQuantity(call("eth_estimateGas", List.of(Map.of("from", from, "to", to, "data", data))).asText());
    }

    /** Read-only contract call at the latest block; returns the raw hex result. */
    public String ethCall(String to, String data) {
        return call("eth_call", List.of(Map.of("to", to, "data", data), "latest")).asText();
    }

    /** Broadcasts a signed transaction; returns its hash. */
    public String sendRawTransaction(String rawHex) {
        return call("eth_sendRawTransaction", List.of(rawHex)).asText().toLowerCase(Locale.ROOT);
    }

    /** Empty while the transaction is not mined (or unknown to the node). */
    public java.util.Optional<Receipt> receipt(String txHash) {
        JsonNode r = call("eth_getTransactionReceipt", List.of(txHash));
        if (r == null || r.isNull() || r.isMissingNode()) {
            return java.util.Optional.empty();
        }
        return java.util.Optional.of(new Receipt("0x1".equals(r.path("status").asText()),
                Numeric.decodeQuantity(r.path("blockNumber").asText()).longValueExact()));
    }

    public List<ChainDeposit> depositLogs(String contract, long fromBlock, long toBlock) {
        Map<String, Object> filter = Map.of(
                "address", contract,
                "topics", List.of(Eth.DEPOSITED_TOPIC),
                "fromBlock", Numeric.toHexStringWithPrefix(BigInteger.valueOf(fromBlock)),
                "toBlock", Numeric.toHexStringWithPrefix(BigInteger.valueOf(toBlock)));
        return parseDepositLogs(call("eth_getLogs", List.of(filter)), contract);
    }

    /** Pure parser for an eth_getLogs result; skips removed (re-orged) logs and logs of other contracts. */
    static List<ChainDeposit> parseDepositLogs(JsonNode result, String contract) {
        List<ChainDeposit> out = new ArrayList<>();
        if (result == null || !result.isArray()) {
            throw new RpcException("eth_getLogs returned no array");
        }
        for (JsonNode log : result) {
            if (log.path("removed").asBoolean(false)) {
                continue;
            }
            if (!contract.equalsIgnoreCase(log.path("address").asText())) {
                continue;
            }
            JsonNode topics = log.path("topics");
            if (topics.size() != 2 || !Eth.DEPOSITED_TOPIC.equalsIgnoreCase(topics.get(0).asText())) {
                continue;
            }
            String data = log.path("data").asText();
            if (data.length() != 66) {
                continue; // one uint256 = 0x + 64 hex digits
            }
            out.add(new ChainDeposit(
                    log.path("transactionHash").asText().toLowerCase(Locale.ROOT),
                    Numeric.decodeQuantity(log.path("logIndex").asText()).intValueExact(),
                    Numeric.decodeQuantity(log.path("blockNumber").asText()).longValueExact(),
                    Eth.addressFromTopic(topics.get(1).asText()),
                    Numeric.toBigInt(data)));
        }
        return out;
    }

    private JsonNode call(String method, List<?> params) {
        String body = Json.write(Map.of("jsonrpc", "2.0", "id", ids.incrementAndGet(), "method", method, "params", params));
        HttpRequest req = HttpRequest.newBuilder(URI.create(props.eth().rpcUrl()))
                .timeout(Duration.ofSeconds(20))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body)).build();
        HttpResponse<String> res;
        try {
            res = http.send(req, HttpResponse.BodyHandlers.ofString());
        } catch (IOException e) {
            throw new RpcException(method + " failed: " + e.getMessage());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new RpcException(method + " interrupted");
        }
        if (res.statusCode() != 200) {
            throw new RpcException(method + " returned HTTP " + res.statusCode());
        }
        JsonNode node = Json.read(res.body());
        if (node.hasNonNull("error")) {
            JsonNode error = node.path("error");
            String data = error.path("data").isTextual() ? error.path("data").asText() : null;
            throw new RpcRejected(method + ": " + error.path("message").asText("RPC error"), data);
        }
        return node.path("result");
    }
}
