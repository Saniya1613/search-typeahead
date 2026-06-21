# VIVA QUESTION BANK

Likely examiner questions with answers you can say out loud. Practice saying
these in your own words — don't memorize verbatim. Grouped by topic. The ⭐ ones
are the most likely / highest-value.

---

## A. Architecture & data model

**Q. Walk me through what happens when I type "ip" and press Enter.**
- Each debounced keystroke fires `GET /suggest?q=ip`. The server hashes the key
  `suggest:ip`, the consistent-hashing ring picks the owning Redis node, and we
  check it. On a hit we return the cached top-10; on a miss we walk the trie to
  the `ip` node, collect its descendants, sort by count, cache the result with a
  60s TTL, and return it.
- Pressing Enter fires `POST /search {query:"ip"}`. That returns
  `{message:"Searched"}` immediately, bumps the in-memory trie now, and enqueues
  the event for a batched SQLite write. On the next flush, SQLite is updated and
  the cache keys for `i`, `ip` are invalidated.

**⭐ Q. Why do you store data in both SQLite *and* a trie? Isn't that duplication?**
- Different jobs. SQLite is the **durable source of truth** — it survives
  restarts. The trie is an **in-memory read index** for fast prefix lookup, and
  it's rebuilt from SQLite on every boot. We trade some memory + a ~300 ms boot
  cost for ~0.3 ms reads. If they ever disagree, SQLite wins.

**Q. What if the trie and SQLite disagree?**
- Can only happen transiently (trie updated immediately, SQLite on flush). On
  restart the trie is rebuilt from SQLite, so SQLite is authoritative. A crash
  loses at most the un-flushed window of increments (see batching).

---

## B. Trie ⭐

**⭐ Q. Why a trie? What's its complexity?**
- Finding completions of a P-character prefix is **O(P)** to reach the prefix
  node — independent of total queries stored — then O(M) to gather the M
  completions and O(M log M) to sort by count. Compare to `LIKE 'car%'` in SQL,
  which scans on every keystroke.

**Q. What's the worst case for the trie?**
- A 1-character prefix like "a": M is huge, so collect+sort is expensive. We
  mitigate with the cache (repeated short prefixes hit the cache) and by routing
  the **empty** prefix to trending instead of "collect all 150k and sort".

**Q. How would you make even 1-char prefixes O(P)?**
- Precompute and store the **top-k completions at each node**, updated on insert.
  Then a lookup is just "walk to the node, read its top-k" — no per-request sort.
  I kept the simpler version because measured p95 is ~2 ms at this scale, but I
  know the upgrade.

**Q. Why a `Map` for children instead of a 26-element array?**
- Our queries aren't just a–z; they contain digits and apostrophes (e.g.
  "iphone's"). A Map handles an arbitrary alphabet without wasting 26 slots per
  node or breaking on non-letters.

**Q. How do you handle case / whitespace / no match / empty?**
- `Trie.normalize()` lowercases + trims so "IPHONE"/" iphone " are one key. No
  match returns an empty list with HTTP 200 (not a 404). Empty prefix returns
  trending.

**Q. Why not a sorted array + binary search?**
- Binary search finds the prefix range fine, but it's sorted by **string**, not
  count, so you'd still sort the range by count per request; and inserting a new
  query is O(n) (shift elements). We have live count updates, so the trie's
  O(word-length) update wins.

---

## C. Consistent hashing ⭐⭐ (most likely deep-dive)

**⭐ Q. Why not just `hash(key) % numNodes`?**
- Because when `numNodes` changes (a node dies or you add one), the modulus
  changes for almost every key — `hash%3` vs `hash%4` disagree for most keys. So
  nearly the whole cache moves at once → mass misses → every miss hits the DB
  (thundering herd). Consistent hashing moves only ~K/N keys when N changes.

**⭐ Q. Explain the ring. How do you find a key's node?** *(be ready to draw it)*
- Imagine a circle of positions 0…2³²−1. Each node is placed at positions by
  hashing its id. To find a key's owner, hash the key to a position and walk
  **clockwise** to the first node. In code that's a binary search for the first
  ring position ≥ the key's hash, wrapping to index 0 if you fall off the end.

**⭐ Q. What are virtual nodes and why do you need them?**
- If each node sat at one point, three random points split the circle very
  unevenly — one node could own most of it. So each physical node is hashed to
  **150** positions; the many small arcs average out to ≈1/3 each. More vnodes ⇒
  more even distribution and less disruption on join/leave. I measured 645/615/617
  across the 3 nodes with 150 vnodes.

**Q. What happens to the cache when a node is added or removed?**
- Only the keys on the affected arcs move (≈K/N of them); the rest keep their
  owner. Keys that move just miss once and repopulate on the new node. Correctness
  is never affected — the cache is rebuildable from the trie/SQLite.

**Q. Why did your distribution start out uneven, and how did you fix it?**
- My first hash (plain FNV-1a) had weak avalanche on the trailing bytes, so the
  vnode labels "cache-a#0", "cache-a#1"… landed close together and clumped —
  43% spread. I added a `fmix32` bit-mixing finalizer (from MurmurHash3) so one
  bit flip changes ~half the output bits; spread dropped to ~9%.

**Q. Why FNV-1a and not SHA-256 / MD5?**
- We don't need cryptographic security, just cheap uniform spread. FNV-1a +
  fmix32 is a few integer ops per key — far faster than a crypto hash, and good
  enough for even key distribution.

**Q. How do you know a key always maps to the same node?**
- The hash is deterministic and the ring only changes when nodes join/leave. Same
  key + same ring ⇒ same node every time. `GET /cache/debug?prefix=app` proves it.

---

## D. Caching

**Q. What caching strategy is this?**
- **Cache-aside** (lazy loading): the app checks the cache, and on a miss it
  computes the value and writes it back. The cache doesn't know about the DB; the
  app mediates.

**Q. What's your TTL and why?**
- 60 seconds. Short enough that count/trending changes surface quickly, long
  enough that hot prefixes stay cached across many requests. It's also the upper
  bound on how stale a cached ranking can be.

**Q. What if a Redis node is down?**
- We treat the read as a miss and serve from the trie (graceful degradation). The
  cache is an optimization, never a correctness dependency.

**⭐ Q. How/when do you invalidate stale cache entries?**
- Two mechanisms: TTL expiry (backstop), and **explicit invalidation** when the
  batch writer flushes — it deletes the cache keys for every prefix of each
  changed query, so a ranking change is visible on the next request.

**Q. Why disable Redis persistence (`--save "" --appendonly no`)?**
- A cache should be rebuildable from the source of truth. If a node restarts
  empty, requests just miss and repopulate it. Persisting cache data would waste
  I/O and risk serving stale data after a restart.

---

## E. Batch writes ⭐

**⭐ Q. Why batch writes? Show me the benefit.**
- To avoid one tiny transaction per search under load. We buffer events and flush
  them together, aggregating duplicates. Measured: **1000 events → 7 DB writes,
  ~99% reduction** (`/metrics`).

**Q. How is the buffer structured? Why a Map?**
- `Map<query, pendingDelta>`. The Map itself aggregates: re-searching a query just
  increments its value, so the flush does one upsert per **distinct** query, not
  per event.

**Q. What triggers a flush?**
- Either **size** (500 distinct queries buffered) or **time** (every 2 s),
  whichever comes first. Size bounds memory/latency under load; time bounds
  staleness when load is light.

**⭐ Q. What happens if the process crashes before a flush?**
- The un-flushed increments (≤ ~2 s worth) are **lost**, because the buffer is
  in-process. Acceptable here — counts are approximate. In production I'd use a
  durable queue (Redis list / Kafka) as the buffer, shorten the window, or
  explicitly accept eventual consistency. Committed SQLite writes are crash-safe
  via WAL.

**Q. Why does search feel instant if the DB write is deferred?**
- `enqueue()` bumps the **in-memory trie** immediately, so the next `/suggest`
  reflects the search right away. Only the durable SQLite write waits for the
  flush.

---

## F. Trending ⭐

**⭐ Q. How does trending differ from sorting by count?**
- Sorting by count parks all-time giants at the top forever. Trending blends a
  **recency score** (decayed recent activity) with a popularity prior, so
  recently-hot queries rise. `score = α·ln(1+count) + β·recency`. β=0 gives the
  basic count-only ranking; β>0 gives the enhanced one.

**⭐ Q. How do you compute the recency score?**
- We bucket searches by clock-hour in `query_hourly`. Each bucket's hits are
  weighted by exponential decay `0.5^(age/halfLife)` with a 6-hour half-life, and
  summed over a 48-hour window. Recent buckets dominate.

**⭐ Q. How does this avoid a one-time spike ranking forever?**
- A spike's hits sit in buckets that keep aging; their decay weight falls toward
  zero, so the query drops back within a day or two unless it keeps getting
  searched (refilling recent buckets).

**Q. Why `ln(1+count)` and not raw count in the blend?**
- Raw count lets all-time giants (count in the millions) swamp the recency term.
  `log` compresses that range so recency can actually move the ranking, while
  still giving popular queries a sensible prior.

**Q. What's the trade-off in your window/half-life choice?**
- Bigger window / longer half-life ⇒ smoother, more stable, but slower to react.
  Smaller ⇒ fresher but noisier and spike-sensitive. It's a freshness vs.
  stability vs. compute trade-off.

**Q. When does trending data get cleaned up?**
- `pruneOld()` deletes `query_hourly` rows older than the window, so the table
  doesn't grow unbounded.

---

## G. APIs & frontend

**Q. What does `POST /search` return and why a dummy?**
- `{message:"Searched"}`. The assignment scopes out a real search backend; the
  endpoint exists to record the event and update counts. The UI just echoes the
  message.

**Q. Why debounce the frontend? What value and why?**
- 300 ms. Without it, typing "iphone" fires 6 requests; with it, we wait until
  typing pauses and fire ~1. Saves backend load and avoids flicker. We also
  discard out-of-order responses (a stale "ip" response can't overwrite a newer
  "iph" one) using a request-id ref.

**Q. How does keyboard navigation work?**
- Arrow up/down move a highlighted index (wrapping), Enter searches the
  highlighted suggestion (or the raw text if none highlighted), Escape closes the
  dropdown. Mouse hover syncs the highlight; click searches.

---

## H. Non-functional & ops

**Q. What's your p95 latency and how did you measure it?**
- ~2 ms p95 on `/suggest`, via `npm run bench` — 5000 serial requests with a
  hot-prefix-biased workload, reading `/metrics` for the hit rate (~75%). I report
  p95/p99 because the tail is what users feel, not the mean.

**Q. Where's the Docker part?**
- `docker-compose.yml` runs the 3 Redis cache nodes as containers
  (`docker compose up -d`). The backend connects to all three; the ring routes
  between them. (For dev without Docker, `npm run redis:up` runs the same 3 nodes
  as local processes — identical behaviour.)

**Q. How would this scale to millions of queries / many app servers?**
- Trie memory grows with distinct queries; shard the trie by first character or
  move to a precomputed top-k store if it won't fit. Add more Redis nodes — the
  ring already handles that with minimal remapping. Run multiple stateless app
  servers behind a load balancer; they share the same Redis cluster and DB. Move
  the durable store from SQLite to a networked DB (Postgres) once one file/one
  process isn't enough.

---

## I. Integrity / "explain this line"

Be ready to open any file and explain a specific line. The highest-risk asks:
- `cache/ring.ts` → `getNode()` binary search + the wrap-to-0, and the `fmix32`
  finalizer.
- `batch.ts` → the buffer swap (`this.buffer = new Map()` before writing) and why
  it prevents losing events that arrive mid-flush.
- `trending.ts` → the `Math.pow(0.5, age / halfLifeHours)` decay line.
- `trie.ts` → why `size++` only when `count === undefined` (don't double-count a
  word that already existed).
