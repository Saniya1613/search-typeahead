/**
 * db.ts — the PRIMARY data store (durable source of truth).
 *
 * Why SQLite (better-sqlite3)?
 *  - Durable: data survives a restart (unlike an in-memory map). The assignment
 *    requires "maintain query-count data reliably".
 *  - Zero-ops: a single file on disk, nothing to administer — easy to open and
 *    inspect (`sqlite3 data/typeahead.db`).
 *  - better-sqlite3 is SYNCHRONOUS. That's a feature here: no callback/promise
 *    juggling, and our reads come from the in-memory trie anyway, so we never
 *    block the event loop on a hot path.
 *
 * IMPORTANT separation of concerns:
 *   The DB is for DURABILITY. It is NOT what we read on every keystroke.
 *   Fast prefix lookups come from the in-memory Trie (trie.ts), which we build
 *   ONCE from this table on boot. DB = source of truth; Trie = read index.
 */

import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DB_PATH = join(__dirname, "..", "data", "typeahead.db");

export const db = new Database(DB_PATH);

// WAL = Write-Ahead Logging. Readers don't block the writer and vice-versa, and
// committed writes are crash-safe (they're fsync'd to the WAL). Relevant to the
// batch-writes phase: it's part of how we keep durability while writing in bulk.
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");

/** Create tables if they don't exist. Safe to call on every boot. */
export function initSchema(): void {
  db.exec(`
    -- The historical, all-time popularity of each query. This is what the
    -- basic ranking sorts by. PRIMARY KEY on query gives us an index for upserts.
    CREATE TABLE IF NOT EXISTS queries (
      query TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 0
    );

    -- Recent activity, bucketed by hour, used by Phase 6 (trending / recency).
    -- One row = "this query was searched <hits> times during clock-hour <hour>".
    -- hour = floor(unixSeconds / 3600). We only keep a rolling window (see trending.ts).
    CREATE TABLE IF NOT EXISTS query_hourly (
      query TEXT NOT NULL,
      hour  INTEGER NOT NULL,
      hits  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (query, hour)
    );

    CREATE INDEX IF NOT EXISTS idx_query_hourly_hour ON query_hourly (hour);
  `);
}

/** Total number of queries — used to log dataset size / confirm ingestion. */
export function countQueries(): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM queries").get() as { n: number };
  return row.n;
}
