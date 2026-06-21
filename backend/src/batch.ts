/**
 * batch.ts — Phase 5: BATCHED WRITES.
 *
 * ── Why batch at all? ───────────────────────────────────────────────────────
 * Every /search is a write. If a query trends, thousands of searches arrive per
 * second, and writing each one straight to SQLite means thousands of tiny
 * transactions — each with its own fsync. The DB becomes the bottleneck and
 * write latency climbs. The fix: don't write each event; COLLECT events in a
 * buffer and FLUSH them together, aggregating duplicates.
 *
 * ── The two things batching buys us ─────────────────────────────────────────
 *   1. Fewer transactions: 1 flush transaction instead of N event transactions.
 *   2. Aggregation: 500 searches for "iphone" in one window become ONE SQL
 *      `count += 500`, not 500 separate `count += 1`. So we also collapse
 *      duplicate keys, not just group them.
 *
 * ── Buffer = a Map (query -> pending delta) ─────────────────────────────────
 * The Map IS the aggregation: re-searching the same query just bumps its value.
 * So the buffer's size is the number of DISTINCT queries pending, and the flush
 * does exactly that many upserts.
 *
 * ── Flush triggers (both, configurable) ─────────────────────────────────────
 *   - SIZE:  buffer reaches MAX_BATCH distinct queries  -> flush now
 *   - TIME:  every FLUSH_MS                              -> flush whatever's there
 * Size keeps memory/latency bounded under load; time bounds staleness when load
 * is light (so a single search still lands within FLUSH_MS).
 *
 * ── Durability trade-off (write this in the README, examiners ask) ──────────
 * Events live in an in-process Map until flushed. If the process crashes
 * mid-window, those un-flushed increments are LOST. For an assignment that's an
 * acceptable trade (we lose at most ~FLUSH_MS of count increments, and counts
 * are approximate popularity signals, not money). In production you'd reduce the
 * window, use a durable queue (Redis list / Kafka) as the buffer so a crash
 * doesn't lose it, or accept the eventual-consistency gap explicitly.
 */

import { db } from "./db.ts";
import type { CacheCluster } from "./cache/client.ts";
import type { Trie } from "./trie.ts";

const MAX_BATCH = 500; // flush once this many DISTINCT queries are pending
const FLUSH_MS = 2000; // ...or at least this often

// Add `delta` to the all-time count.
const upsertCount = db.prepare(`
  INSERT INTO queries (query, count) VALUES (?, ?)
  ON CONFLICT(query) DO UPDATE SET count = count + excluded.count
`);

// Add `delta` to this query's hits for the given clock-hour (feeds trending).
const upsertHourly = db.prepare(`
  INSERT INTO query_hourly (query, hour, hits) VALUES (?, ?, ?)
  ON CONFLICT(query, hour) DO UPDATE SET hits = hits + excluded.hits
`);

export interface BatchStats {
  enqueued: number; // total /search events ever accepted
  flushes: number; // number of flush() runs that wrote something
  dbWrites: number; // number of SQL upserts executed (the number we're minimizing)
  pending: number; // distinct queries currently buffered
  lastFlushSize: number;
}

export class BatchWriter {
  private buffer = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private enqueued = 0;
  private flushes = 0;
  private dbWrites = 0;
  private lastFlushSize = 0;

  constructor(
    private trie: Trie,
    private cache: CacheCluster,
  ) {}

  /** Current clock-hour bucket: floor(unix-seconds / 3600). */
  private static currentHour(): number {
    return Math.floor(Date.now() / 1000 / 3600);
  }

  start(): void {
    if (this.timer) return;
    // unref() so this timer never keeps the process alive on its own.
    this.timer = setInterval(() => void this.flush(), FLUSH_MS);
    (this.timer as any).unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush(); // drain on shutdown so we don't drop the last window
  }

  /**
   * Accept one search event. We do TWO things immediately and one later:
   *   - bump the in-memory trie NOW, so the very next /suggest reflects it
   *     (reads must feel instant; the DB write is what we defer)
   *   - add to the buffer for the deferred DB write
   * The DB (durable) write happens at the next flush.
   */
  enqueue(query: string): void {
    this.enqueued++;
    this.trie.increment(query, 1); // read index updates instantly
    this.buffer.set(query, (this.buffer.get(query) ?? 0) + 1);
    if (this.buffer.size >= MAX_BATCH) void this.flush(); // size trigger
  }

  /** Write the whole buffer to SQLite in ONE transaction, then invalidate cache. */
  async flush(): Promise<void> {
    if (this.buffer.size === 0) return;
    const pending = this.buffer;
    this.buffer = new Map(); // swap out first, so new events buffer while we write
    const hour = BatchWriter.currentHour();

    const writeAll = db.transaction((entries: [string, number][]) => {
      for (const [query, delta] of entries) {
        upsertCount.run(query, delta);
        upsertHourly.run(query, hour, delta);
      }
    });
    const entries = [...pending.entries()];
    writeAll(entries);

    this.flushes++;
    this.dbWrites += entries.length;
    this.lastFlushSize = entries.length;

    // Rankings for these queries just changed -> drop their cached prefix lists
    // so the next /suggest recomputes from the (now-updated) trie. Each query's
    // prefixes are invalidated; TTL would also catch it, but this makes the
    // change visible immediately (relevant to the trending requirement).
    await this.invalidatePrefixes(pending.keys());
  }

  /** Delete cache entries for every prefix of every changed query. */
  private async invalidatePrefixes(queries: Iterable<string>): Promise<void> {
    const keys = new Set<string>();
    for (const q of queries) {
      for (let i = 1; i <= q.length; i++) keys.add(q.slice(0, i));
    }
    await Promise.all([...keys].map((p) => this.cache.invalidate(`suggest:${p}`)));
  }

  stats(): BatchStats {
    return {
      enqueued: this.enqueued,
      flushes: this.flushes,
      dbWrites: this.dbWrites,
      pending: this.buffer.size,
      lastFlushSize: this.lastFlushSize,
    };
  }
}
