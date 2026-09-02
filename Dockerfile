# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS frontend-build
WORKDIR /build/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM python:3.12-slim-bookworm AS runtime

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    FRONTEND_DIR=/app/frontend \
    DATA_DIR=/data

RUN groupadd --gid 10001 detangle \
    && useradd --uid 10001 --gid detangle --no-create-home --shell /usr/sbin/nologin detangle \
    && mkdir -p /app/backend /app/frontend /data \
    && chown -R detangle:detangle /app /data

WORKDIR /app/backend
COPY backend/ ./
RUN pip install --no-cache-dir .

COPY --from=frontend-build --chown=detangle:detangle /build/frontend/dist/ /app/frontend/

USER detangle
EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--proxy-headers", "--forwarded-allow-ips", "*"]

