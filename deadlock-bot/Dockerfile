# deadlock-bot: `docker compose --profile bot up` starts it in `serve` mode (see README.md).
# Builds on x86-64 and on ARM (for example Oracle Cloud's free Ampere VMs).
FROM rust:1-bookworm AS build
# protoc compiles Valve's message definitions (libprotobuf-dev has the google/protobuf/*.proto files they import);
# cmake is a fallback for the TLS library's C code.
RUN apt-get update \
    && apt-get install -y --no-install-recommends protobuf-compiler libprotobuf-dev cmake \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY vendor ./vendor
COPY src ./src
RUN cargo build --release --locked

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --home-dir /data bot \
    && mkdir /data && chown bot /data
COPY --from=build /src/target/release/deadlock-bot /usr/local/bin/deadlock-bot
USER bot
# The saved login token and the request log live here: mount a volume so they survive restarts.
ENV DEADLOCK_BOT_HOME=/data \
    DEADLOCK_BOT_LISTEN=0.0.0.0:8090
VOLUME /data
EXPOSE 8090
ENTRYPOINT ["deadlock-bot"]
CMD ["serve"]
