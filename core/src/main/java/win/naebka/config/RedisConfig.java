package win.naebka.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.data.redis.connection.RedisConnectionFactory;
import org.springframework.data.redis.listener.ChannelTopic;
import org.springframework.data.redis.listener.RedisMessageListenerContainer;
import java.nio.charset.StandardCharsets;
import win.naebka.common.Json;
import win.naebka.ws.NaebkaWebSocketHandler;
import win.naebka.ws.WsHub;

@Configuration
public class RedisConfig {

    @Bean
    RedisMessageListenerContainer redisListenerContainer(RedisConnectionFactory factory, NaebkaWebSocketHandler ws) {
        RedisMessageListenerContainer container = new RedisMessageListenerContainer();
        container.setConnectionFactory(factory);
        // WebSocket fan-out: every core instance delivers hub messages to its own connected clients.
        container.addMessageListener((message, pattern) -> {
            String json = new String(message.getBody(), StandardCharsets.UTF_8);
            ws.deliver(Json.read(json).path("topic").asText(), json);
        }, new ChannelTopic(WsHub.CHANNEL));
        return container;
    }
}
