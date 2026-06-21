# CONCEPTS — read this before the viva

This explains **every concept and every design choice** in the project, in plain
English. If you can explain each section here in your own words, you can defend
the whole submission. Read it top to bottom once, then re-read §4 (consistent
hashing), §5 (batching) and §6 (trending) — those are where examiners dig.

---

## 0. The 10-second summary

A search box calls `GET /suggest?q=<prefix>` on every (debounced) keystroke and
shows the top-10 most popular completions. Pressing Enter calls `POST /search`,
which records that the query was searched (so its popularity goes up). Behind the
API:

- **SQLite** is the durable source of truth (`query → count`).
- A **trie** (built from SQLite on boot) answers prefix lookups in memory, fast.
- A **distributed cache** of 3 Redis nodes, addressed by a **consistent-hashing
  ring**, sits in front of the trie for repeated prefixes.
- Search events are **batched** before being written to SQLite.
- **Trending** re-ranks suggestions by recent activity, not just all-time count.

```
            ┌──────────────┐   GET /suggest?q=ip      ┌───────────────────────┐
   Browser  │  React app   │ ───────────────────────► │  Fastify backend      │
  (Vite UI) │  debounced   │ ◄─────────────────────── │                       │
            └──────────────┘   {suggestions:[...]}     │  ┌─────────────────┐  │
                  │                                     │  │ cache-aside     │  │
                  │ POST /search {query}                │  └───────┬─────────┘  │
                  ▼                                     │          │ miss       │
        ┌───────────────────┐                          │   ┌──────▼───────┐    │
        │ consistent-hashing│  pick node for prefix     │   │   Trie       │    │
        │   ring (app code) │◄─────────────────────────────│ (in-memory)  │    │
        └─────────┬─────────┘                          │   └──────┬───────┘    │
            ┌─────┼─────┐                               │          │ built on   │
            ▼     ▼     ▼                               │          ▼ boot       │
        ┌──────┐┌──────┐┌──────┐                        │   ┌──────────────┐    │
        │Redis ││Redis ││Redis │  3 independent nodes   │   │   SQLite     │    │
        │:6379 ││:6380 ││:6381 │  (Docker containers)   │   │ (durable)    │    │
        └──────┘└──────┘└──────┘                        │   └──────▲───────┘    │
                                                        │          │ batched    │
                                                        │   ┌──────┴───────┐    │
                                                        │   │ BatchWriter  │    │
                                                        │   └──────────────┘    │
                                                        └───────────────────────┘
```

---

## 1. Two stores, two jobs: durability vs. read speed

**The single most important architectural idea here.** We deliberately keep the
data in *two* places that do *two different jobs*:

| | SQLite (`db.ts`) | Trie (`trie.ts`) |
|---|---|---|
| Job | **Durability** — survive restarts/crashes | **Read speed** — fast prefix lookup |
| Lives | On disk | In RAM (process memory) |
| Lost on crash? | No | Yes — but rebuilt from SQLite on boot |
| Updated | Via batched writes | Immediately on each search |

On boot, `createContext()` reads every `(query, count)` row from SQLite and
`insert`s it into the trie (≈300 ms for 150k rows). SQLite is the **source of
truth**; the trie is a **derived read index**. If they ever disagree, SQLite
wins (a restart rebuilds the trie from it).

> Why not just query SQLite per keystroke? Because `... WHERE query LIKE 'car%'`
> scans an index/table on every keystroke, and we get a keystroke every few
> hundred ms per user. The trie turns "find completions of a prefix" into a tiny
> in-memory walk (see §3).

---

## 2. The dataset (Phase 0)

- Source: the `wordfreq` Python package — English word frequencies built from a
  large real-world text corpus.
- `scripts/make_dataset.py` takes the top 150,000 words and converts each word's
  frequency (a number in [0,1]) into an integer **count** = `freq × 1e9`. So
  `count` = "expected occurrences per billion words" — a genuine, monotonic
  popularity signal (common words → big counts, rare words → small counts).
- `scripts/ingest.ts` loads `data/dataset.csv` into the SQLite `queries` table in
  **one transaction** (≈150k rows). One transaction, not 150k — same batching
  idea as Phase 5.
- Result: **149,998 rows**, comfortably over the 100k minimum.

> Honest framing for the viva: this is word-frequency data used as a search-
> popularity proxy. The assignment explicitly allows "keywords / similar text
> entries" with counts "derived by aggregation". The schema and code don't care
> what the strings are — swap in Amazon product titles + review counts and
> nothing else changes.

---

## 3. The Trie — prefix suggestions (Phase 1)

### What it is
A tree where each **edge** is one character and each **path from the root**
spells a prefix. Words sharing a prefix share a path until they diverge.
Terminal nodes store the query's `count`.

### Why it's fast
To find completions of `"car"` we walk 3 edges (`c → a → r`) — **O(P)** where P
is the prefix length, *independent of how many queries we store*. Then we
collect the subtree below that node (the M completions) and sort them by count.

- Reach prefix node: **O(P)**
- Collect M descendants: **O(M)**
- Sort by count: **O(M log M)**
- Return top 10: slice

### The honest weakness (know this!)
For a 1-character prefix like `"a"`, M is huge (every word starting with `a`), so
collect+sort is the expensive case. Two mitigations in this project:
1. The **cache** (§4) absorbs repeated short prefixes.
2. The **empty** prefix never hits this path — it returns **trending** instead of
   "collect all 150k and sort".

A production system would precompute & store the **top-k at each node** so a
lookup is O(P) with no per-request sort. We didn't, to keep the trie simple and
explainable — and the measured p95 (≈2 ms, §7) shows it's fine at this scale.

### Alternative we rejected: sorted array + binary search
You *can* binary-search a sorted array of queries to find the prefix range. But
**updating a count** (which happens on every search) means finding the entry and
the array stays sorted only by string, not by count — you'd still scan the range
and sort by count per request, and inserting a brand-new query is O(n) (shift
elements). The trie inserts/updates in O(word length). We expect live updates, so
the trie wins.

### Edge cases handled
- **Empty prefix** → trending (not an error, not a full scan).
- **No match** (`"zzzznope"`) → empty list, HTTP 200 (graceful, not a 404).
- **Mixed case / whitespace** → `Trie.normalize()` lowercases + trims, so
  `"IPHONE"`, `" iphone "`, `"iPhone"` are one key.

---

## 4. Distributed cache + consistent hashing (Phase 4) — the big one

### Why a cache
Short, popular prefixes (`"a"`, `"ip"`, `"app"`) are requested constantly and the
answer rarely changes second-to-second. Caching their result avoids re-walking
the trie every time. We use **cache-aside**:

1. Compute the cache key for the prefix (`suggest:<prefix>`).
2. Ask the ring which node owns it; read from that node.
3. **HIT** → return cached JSON. **MISS** → compute from the trie, write it back
   with a 60-second TTL, return it.

The cache is an **optimization, never correctness**: if a node is down we treat
it as a miss and serve from the trie (graceful degradation). Source of truth is
always trie/SQLite.

### Why 3 separate Redis nodes
The rubric grades a *distributed* cache using consistent hashing. That only means
something with **multiple independent nodes** to route between. Each node holds a
**disjoint slice** of the keyspace (decided by the ring), so together they give
more cache capacity and no single node holds everything. We run them as 3 Docker
containers (`docker-compose.yml`) on ports 6379/6380/6381.

### The problem consistent hashing solves
We must map each key to one of N nodes. The naive way is `node = hash(key) % N`.
**Why that's bad:** the moment N changes (a node dies, or we add a 4th), the
modulus changes for *almost every key*. `hash % 3` and `hash % 4` disagree for
most keys → nearly the entire cache is suddenly on the "wrong" node → mass cache
miss → every miss stampedes the database. That's the **thundering herd** we want
to avoid.

### The ring (`cache/ring.ts`)
Picture a circle of positions `0 … 2³²−1` (the hash space).

- Place each **node** at one or more positions by hashing its id.
- To find a **key's** owner: hash the key to a position and walk **clockwise** to
  the first node you meet. That node owns the key. (In code: binary-search the
  sorted ring for the first position ≥ the key's hash; wrap to index 0 if you run
  off the end — that's the circle closing.)

Now if a node leaves, only the keys on **its arc** move (they fall to the next
node clockwise); every other key keeps its owner. On average only ~**K/N** keys
move when N changes, instead of nearly all of them.

### Virtual nodes (examiners poke here)
If each physical node sat at just **one** point, three random points would carve
the circle into three very **uneven** arcs — one node could own 60% by luck. So
each physical node is hashed to **many** positions (we use **150**). Those 150
small arcs scatter around the circle and average out, so each physical node ends
up owning ≈1/3 of the space. More vnodes ⇒ smoother distribution and smaller
disruption when a node joins/leaves.

**We measured this.** With a weak hash, 3 nodes split a real prefix sample as
959/249/669 (very uneven). After adding a proper bit-mixing finalizer to the hash
(see below), it became **645/615/617** — near-perfect thirds. (`GET /cache/ring`
shows this live.)

### The hash function (`fnv1a`)
We don't need crypto strength — we need **cheap, deterministic, uniform** output
so keys *and* node positions scatter evenly. We use **FNV-1a** to fold the bytes
into 32 bits, then a **`fmix32` finalizer** (from MurmurHash3) to avalanche the
bits (flip one input bit → ~half the output bits flip). Plain FNV-1a has weak
avalanche on the last byte, so `"cache-a#1"` and `"cache-a#2"` would land almost
on top of each other and the ring would clump — the finalizer is what fixed the
distribution from 43% spread to ~9%.

### Cache invalidation (ties into Phase 5/6)
When a query's count changes, its cached prefix lists are stale. Two things keep
the cache fresh:
1. **TTL** (60 s) — every entry expires on its own; an upper bound on staleness.
2. **Explicit invalidation** — when the batch writer flushes a query, it deletes
   the cache keys for **all prefixes of that query** (`i`, `ip`, `iph`, …). So a
   ranking change shows up on the next request, not up-to-60s later.

We cache the **full top-10 per prefix** under one key and slice client-side, so
invalidation is one key per prefix (no per-limit fan-out).

### Debug endpoints (show these in the demo)
- `GET /cache/debug?prefix=app` → which node owns `app`, and is it currently
  cached (hit) or not (miss).
- `GET /cache/ring` → distribution of a real prefix sample across the 3 nodes.

---

## 5. Batch writes (Phase 5)

### Why
Every `/search` is a write. If a query trends, thousands of searches/sec arrive,
and writing each straight to SQLite means thousands of tiny transactions (each
with its own fsync) → the DB becomes the bottleneck.

### How (`batch.ts`)
- Each search is `enqueue`d into a **buffer** that is a `Map<query, pendingDelta>`.
  The Map **is** the aggregation: re-searching the same query just bumps its
  value. So 500 searches for "iphone" become **one** `count += 500`, not 500
  `+= 1`.
- A background flusher writes the whole buffer to SQLite in **one transaction**,
  triggered by **either**:
  - **size**: buffer reaches 500 distinct queries, or
  - **time**: every 2 seconds.
  Size bounds memory/latency under load; time bounds staleness when load is light.
- The **trie is bumped immediately** inside `enqueue()` (reads feel instant);
  only the **durable SQLite write** is deferred.

### Measured result
**1000 search events → 7 DB writes = 99.3% fewer writes.** (`GET /metrics` shows
`enqueued`, `dbWrites`, `writeReduction` live.)

### Durability trade-off (examiners always ask)
Un-flushed events live in an in-process Map. **If the process crashes mid-window,
those increments are lost** (at most ~2 s worth). For an assignment that's an
acceptable trade — counts are approximate popularity signals, not money. In
production you'd: shorten the window, use a **durable queue** (a Redis list or
Kafka) as the buffer so a crash doesn't lose it, or explicitly accept the
eventual-consistency gap. SQLite WAL mode (`journal_mode=WAL`) makes the writes
that *do* commit crash-safe.

---

## 6. Trending searches (Phase 6)

### The problem with all-time count
`"the"` has a gigantic historical count, so ranking by count alone parks it at #1
forever. "Trending" should surface **what's hot now**.

### How we track "recent"
On flush, we also write `query_hourly(query, hour, hits)` where
`hour = floor(now / 3600)`. So for each query we know how many times it was
searched in each recent clock-hour. We look back over a **48-hour window** of
these buckets.

### Recency score with exponential decay
A search 1 hour ago should count more than one 30 hours ago. We weight each
bucket by an exponential **decay**:

```
weight(age) = 0.5 ^ (age_in_hours / HALF_LIFE)         HALF_LIFE = 6h
recency     = Σ over buckets  hits(bucket) × weight(age_of_bucket)
```

With a 6-hour half-life: this hour counts ×1.0, 6h ago ×0.5, 12h ago ×0.25, …

**Why a one-time spike doesn't dominate forever** (key point): a spike's hits sit
in buckets that keep getting older, so their weight decays toward zero — within a
day or two the query falls back down on its own. A genuinely popular query keeps
refilling recent (high-weight) buckets and stays up.

### Blending with popularity
```
score = ALPHA × ln(1 + total_count) + BETA × recency      ALPHA=1, BETA=2
```
- `ln(1 + count)` is a gentle popularity **prior** so a brand-new query with 3
  recent hits doesn't beat an established one with similar recent activity. We
  use `log`, not raw count, so all-time giants don't blow everyone away.
- `BETA` controls how much "hot now" matters vs. the prior.

### Basic vs. enhanced (the assignment wants both)
Same endpoint, **one knob**: `BETA = 0` ⇒ **basic** (rank purely by count);
`BETA > 0` ⇒ **enhanced** (recency-aware). `GET /trending?mode=basic|enhanced`.

**We demonstrated the difference:** searching `"the"` (count 53.7M) a few times
plus `"frog"` (small count) many times → basic ranks `"the"` #1; enhanced ranks
`"frog"` above it and drops `"the"` to the bottom, because `"the"` has almost no
recent activity.

### Cache invalidation when rankings shift
Covered in §4: the flush that updates these counts also deletes the affected
prefixes' cache keys, so the new ranking is visible immediately; TTL is the
backstop.

### Trade-off: window size
Bigger window/longer half-life = smoother, more stable trending but **slower to
react**; smaller = **fresher** but noisier and more sensitive to single spikes.
That's the freshness ↔ stability ↔ compute trade-off the assignment asks about.

---

## 7. Non-functional results (Phase 7)

Measured with `npm run bench` (5000 serial `/suggest` requests, hot-prefix-biased
workload), backend + 3 local Redis nodes on one laptop:

| Metric | Value |
|---|---|
| p50 latency | ~0.3 ms |
| p95 latency | ~2 ms |
| p99 latency | ~8 ms |
| cache hit rate | ~75% |
| throughput (1 serial client) | ~1,100 req/s |
| trie build on boot | ~300 ms for 150k rows |

We report **p95/p99**, not just the average, because the tail is what users feel.

---

## 8. Where each requirement lives (quick map)

| Requirement | File |
|---|---|
| Typeahead suggestions, top 10, sorted by count | `src/trie.ts`, `src/routes/suggest.ts` |
| Debounce, empty/no-match/case handling | `frontend/src/App.jsx`, `Trie.normalize` |
| `POST /search` returns `{message:"Searched"}` | `src/routes/search.ts` |
| Durable primary store | `src/db.ts` (SQLite) |
| Distributed cache + consistent hashing | `src/cache/ring.ts`, `src/cache/client.ts` |
| `GET /cache/debug` | `src/routes/cache.ts` |
| Batch writes | `src/batch.ts` |
| Trending (basic + enhanced) | `src/trending.ts`, `src/routes/trending.ts` |
| Latency / hit-rate measurement | `scripts/bench.ts`, `GET /metrics` |
| Docker for cache nodes | `docker-compose.yml` |
