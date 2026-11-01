package win.naebka.config;

import java.util.Map;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;
import org.springframework.web.socket.server.HandshakeInterceptor;
import win.naebka.ws.NaebkaWebSocketHandler;

@Configuration
@EnableWebSocket
public class WebSocketConfig implements WebSocketConfigurer {
    private final NaebkaWebSocketHandler handler;

    public WebSocketConfig(NaebkaWebSocketHandler handler) {
        this.handler = handler;
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(handler, "/ws", "/ws/lobby", "/ws/matches/*")
                .addInterceptors(new ClientIpInterceptor())
                .setAllowedOriginPatterns("*");
    }

    /** Keeps the real client IP (behind nginx) for the poker same-IP restriction. */
    static class ClientIpInterceptor implements HandshakeInterceptor {
        @Override
        public boolean beforeHandshake(ServerHttpRequest request, ServerHttpResponse response, WebSocketHandler wsHandler,
                                       Map<String, Object> attributes) {
            String forwarded = request.getHeaders().getFirst("X-Forwarded-For");
            if (forwarded != null && !forwarded.isBlank()) {
                attributes.put("clientIp", forwarded.split(",")[0].trim());
            } else if (request.getRemoteAddress() != null) {
                attributes.put("clientIp", request.getRemoteAddress().getAddress().getHostAddress());
            }
            return true;
        }

        @Override
        public void afterHandshake(ServerHttpRequest request, ServerHttpResponse response, WebSocketHandler wsHandler,
                                   Exception exception) {}
    }
}
