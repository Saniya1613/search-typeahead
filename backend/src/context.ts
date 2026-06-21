/**
 * context.ts — wires the app's long-lived components together and hands them to
 * the routes. Keeping them in one object (instead of module-level globals)
 * makes the data flow explicit and easy to follow.
 *
 * Components grow phase by phase:
 *   Phase 1/2: trie
 *   Phase 4:   cache (consistent-hashing ring over 3 Redis nodes)
 *   Phase 5:   batch (write queue + flusher)
 *   Phase 6:   trending (recency-aware ranking)
 */

import { db, initSchema, countQueries } from "./db.ts";
import { Trie } from "./trie.ts";
import { CacheCluster } from "./cache/client.ts";
import { BatchWriter } from "./batch.ts";
import { TrendingRanker } from "./trending.ts";

export interface AppContext {
  trie: Trie;
  cache: CacheCluster;
  batch: BatchWriter;
  trending: TrendingRanker;
}

/** Build the in-memory trie from the durable SQLite table. Runs once on boot. */
function buildTrie(): Trie {
  const trie = new Trie();
  // Stream rows instead of loading them all into a JS array first — .iterate()
  // pulls one row at a time, so peak memory stays low even for 150k rows.
  const stmt = db.prepare("SELECT query, count FROM queries");
  for (const row of stmt.iterate() as IterableIterator<{ query: string; count: number }>) {
    trie.insert(row.query, row.count);
  }
  return trie;
}

export function createContext(): AppContext {
  initSchema();
  const t0 = performance.now();
  const trie = buildTrie();
  const ms = (performance.now() - t0).toFixed(0);
  console.log(`[boot] trie built: ${trie.wordCount} queries from ${countQueries()} DB rows in ${ms}ms`);

  const cache = new CacheCluster();
  console.log(`[boot] cache cluster: ${cache.ownerOf("suggest:test") ? "3 nodes via consistent-hashing ring" : "no nodes"}`);

  const batch = new BatchWriter(trie, cache);
  batch.start();
  console.log("[boot] batch writer started");

  const trending = new TrendingRanker();

  return { trie, cache, batch, trending };
}
