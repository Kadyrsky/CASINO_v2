# Built from the repository root (docker-compose: context ".", dockerfile core/Dockerfile), so it can include the
# frontend: the core serves the built SolidJS app itself (config/FrontendConfig.java), no separate nginx container.
FROM node:22-alpine AS frontend
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY frontend/ .
# The music comes from the "music" stage below, so a local copy in public/ isn't built in a second time.
RUN rm -rf public/music && npm run build

# Deadlock's music and stingers (frontend/scripts/wiki_music.py, standard library only). The audio is Valve's, so it
# isn't kept in git: files already in frontend/public/music (from running the script, or copied from a teammate) are
# used as they are, and only what's missing is fetched from the Deadlock Wiki. ffmpeg measures each file's loudness so
# the player can even them out. If background tracks are still missing, the build stops and says what to do; a failed
# step isn't cached, so the next build tries again. NAEBKA_MUSIC=skip builds with the local files only (maybe none).
FROM python:3.12-alpine AS music
RUN apk add --no-cache ffmpeg
ARG MUSIC=fetch
COPY frontend/scripts/wiki_music.py /wiki_music.py
COPY frontend/public/ /tmp/public/
RUN mkdir -p /music \
    && if [ -d /tmp/public/music ]; then cp -r /tmp/public/music/. /music/; fi \
    && if [ "$MUSIC" = "skip" ]; then python /wiki_music.py --out /music --offline; \
       else python /wiki_music.py --out /music --require; fi

FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /src
COPY core/pom.xml .
RUN mvn -q -B dependency:go-offline
COPY core/src ./src
RUN mvn -q -B -DskipTests package

FROM eclipse-temurin:21-jre
WORKDIR /app
COPY --from=build /src/target/naebka-core-*.jar app.jar
COPY --from=frontend /app/dist /app/static
COPY --from=music /music /app/static/music
ENV SPRING_WEB_RESOURCES_STATIC_LOCATIONS=file:/app/static/
EXPOSE 8081
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
