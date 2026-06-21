# Deploying the app

The whole system — Fastify backend, its **3 Redis cache nodes**, and the built
React frontend — ships as **one Docker container** (see `Dockerfile`). The 3 Redis
nodes run as independent processes inside the container on ports 6379/6380/6381,
so the consistent-hashing ring still routes between three real, separate nodes.
One container = one thing to deploy.

## Option A — Render.com (free, recommended)

1. Push this repo to GitHub (done).
2. Go to <https://render.com> → sign in with GitHub.
3. **New + → Blueprint** → pick the `search-typeahead` repo.
   Render reads `render.yaml` and creates the web service automatically.
   (Or **New + → Web Service → Docker** and point it at the repo — same result.)
4. Wait for the build (~3–5 min). You get a public URL like
   `https://search-typeahead.onrender.com`.

Notes for the free tier:
- The service **spins down after ~15 min idle**; the next visit cold-starts in
  ~1 minute. Fine for a demo; mention it if you share the link.
- Free instances have **512 MB RAM**. The in-memory trie for 150k+ rows plus 3
  Redis nodes is close to that ceiling. If the instance restarts under memory
  pressure, lower the dataset size: in `backend/scripts/make_dataset.py` set
  `N_WORDS = 40_000`, re-run it, `npm run ingest`, commit, redeploy.

## Option B — Railway / Fly.io

Both deploy straight from the `Dockerfile`:
- **Railway:** new project → Deploy from GitHub repo → it detects the Dockerfile.
- **Fly.io:** `fly launch` in the repo root (uses the Dockerfile), then `fly deploy`.

## Option C — run the container locally

```bash
docker build -t search-typeahead .
docker run -p 3001:3001 search-typeahead
# open http://localhost:3001
```

## How the container is wired

- `start.sh` launches the 3 `redis-server` processes, then the backend.
- The backend reads `$PORT` (hosts inject it) and listens on `0.0.0.0`.
- The dataset CSV is committed; the image runs `npm run ingest` at build time to
  bake the SQLite DB in, so startup just rebuilds the in-memory trie from it.
- The backend serves the built frontend (`frontend/dist`) at `/` and the API at
  `/suggest`, `/search`, `/trending`, `/cache/*`, `/metrics` — same origin, no CORS.
