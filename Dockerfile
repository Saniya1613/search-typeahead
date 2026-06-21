# All-in-one image: the Fastify backend, its 3 Redis cache nodes, and the built
# React frontend in ONE container. The 3 Redis nodes run as independent processes
# on ports 6379/6380/6381 inside the container — the consistent-hashing ring still
# routes between three real, separate nodes, exactly as it does locally.
#
# Build:  docker build -t search-typeahead .
# Run:    docker run -p 3001:3001 search-typeahead   ->  http://localhost:3001

FROM node:20-bookworm-slim

# redis-server for the cache nodes; build tools in case better-sqlite3 must compile.
RUN apt-get update \
    && apt-get install -y --no-install-recommends redis-server python3 build-essential ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 1) Build the frontend (its output is served by the backend).
COPY frontend/package*.json ./frontend/
RUN cd frontend && npm ci
COPY frontend ./frontend
RUN cd frontend && npm run build

# 2) Backend dependencies (dev deps included — we run TypeScript via tsx).
COPY backend/package*.json ./backend/
RUN cd backend && npm ci
COPY backend ./backend

# 3) Load the committed dataset into SQLite at build time (bakes the DB into the image).
RUN cd backend && npm run ingest

COPY start.sh ./start.sh
RUN chmod +x start.sh

# Hosts (Render/Railway/Fly) inject $PORT; the backend reads it (defaults to 3001).
ENV PORT=3001
EXPOSE 3001
CMD ["./start.sh"]
