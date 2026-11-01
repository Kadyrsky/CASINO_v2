FROM python:3.12-slim
WORKDIR /app
COPY pyproject.toml .
COPY naebka_live ./naebka_live
RUN pip install --no-cache-dir .
ENV PYTHONUNBUFFERED=1
CMD ["python", "-m", "naebka_live.watcher"]
