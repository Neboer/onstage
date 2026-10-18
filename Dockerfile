# Python runtime and application dependencies are version locked; refresh deliberately.
FROM python:3.12.12-slim-bookworm@sha256:593bd06efe90efa80dc4eee3948be7c0fde4134606dd40d8dd8dbcade98e669c
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 \
    ONSTAGE_DATA_DIR=/var/lib/onstage
WORKDIR /srv/onstage
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && groupadd --gid 10001 onstage \
    && useradd --uid 10001 --gid 10001 --no-create-home onstage \
    && mkdir -p /var/lib/onstage && chown 10001:10001 /var/lib/onstage
COPY --chown=10001:10001 app ./app
COPY --chown=10001:10001 static ./static
COPY --chown=10001:10001 tools ./tools
COPY --chown=10001:10001 VERSION SOURCE_REVISION.json ./
ARG SOURCE_REVISION=unknown
ARG SOURCE_REPOSITORY=unknown
LABEL org.opencontainers.image.revision=$SOURCE_REVISION \
      org.opencontainers.image.source=$SOURCE_REPOSITORY
USER 10001:10001
EXPOSE 8765
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8765/healthz', timeout=2)"
# Migrations are a separate controlled command, never part of the entrypoint.
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8765", "--workers", "1", "--no-access-log", "--no-proxy-headers", "--ws-per-message-deflate", "false"]
