# Built from the repository root (docker-compose: context ".", dockerfile core/Dockerfile), so it can include the
# frontend: the core serves the built SolidJS app itself (config/FrontendConfig.java), no separate nginx container.
FROM node:22-alpine AS frontend
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY frontend/ .
RUN npm run build

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
ENV SPRING_WEB_RESOURCES_STATIC_LOCATIONS=file:/app/static/
EXPOSE 8081
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
