# Built from the repository root (docker-compose: context ".", dockerfile core/Dockerfile), so it can include the
# frontend: the core serves the built SolidJS app itself (config/FrontendConfig.java), no separate nginx container.
FROM node:22-alpine AS frontend
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY frontend/ .
RUN npm run build

# Deadlock's music and stingers from the Deadlock Wiki (frontend/scripts/wiki_music.py, standard library only). The
# audio is Valve's, so it is fetched at build time instead of being kept in git. ffmpeg measures each file's loudness
# so the player can even them out. The layer is cached until the script changes; if the wiki can't be reached, the
# site is built without music (the player hides what's missing).
FROM python:3.12-alpine AS music
RUN apk add --no-cache ffmpeg
COPY frontend/scripts/wiki_music.py /wiki_music.py
RUN mkdir -p /music && (python /wiki_music.py --out /music || echo "wiki_music: no music this build")

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
