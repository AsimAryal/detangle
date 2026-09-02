FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app
COPY . .
RUN pip install --no-cache-dir . \
    && useradd --create-home --uid 10001 detangle \
    && mkdir -p /data \
    && chown -R detangle:detangle /data

USER detangle
EXPOSE 8000
CMD ["detangle", "serve", "--host", "0.0.0.0", "--port", "8000"]
