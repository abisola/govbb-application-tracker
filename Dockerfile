# Pinned to Node 22 LTS so prebuilt better-sqlite3 binaries match.
FROM node:22-bookworm-slim

# better-sqlite3 ships prebuilt binaries for linux-x64; build tools are only
# needed if a fallback compile is triggered. We install them and clean up
# in the same layer to keep the final image small.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first to let Docker cache them across code changes.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY . .

# Defaults the platform can override.
ENV NODE_ENV=production \
    PORT=3030 \
    TRACKER_DATA_DIR=/var/data \
    MAIL_OUT_DIR=/var/data/mail-out

# Render mounts a persistent disk at TRACKER_DATA_DIR.
RUN mkdir -p /var/data && chown -R node:node /var/data

USER node
EXPOSE 3030

# Run init (idempotent in production) before starting the server. The init
# step ensures programmes/officers/api_clients exist; it does not touch
# application data on subsequent boots.
CMD sh -c "node seed.js && node server.js"
