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
 * Minimal Ethereum JSON-RPC client (eth_blockNumber, eth_chainId, eth_getLogs) over java.net.http.
 * The browser talks to the chain through MetaMask; only the deposit poller uses this.
 */
@Component
public class EthRpcClient {
    /** One Deposited event from NaebkaCashier. */
    public record ChainDeposit(String txHash, int logIndex, long blockNumber, String from, BigInteger amountWei) {}

    public static class RpcException extends RuntimeException {
        public RpcException(String message) {
            super(message);
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
            throw new RpcException(method + ": " + node.path("error").path("message").asText("RPC error"));
        }
        return node.path("result");
    }
}
