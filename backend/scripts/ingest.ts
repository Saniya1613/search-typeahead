/**
 * ingest.ts — one-off loader: data/dataset.csv  ->  SQLite `queries` table.
 *
 * Run once (after make_dataset.py):  npm run ingest
 *
 * Performance note for the viva: inserting 150k rows one-by-one with autocommit
 * would mean 150k separate transactions (and 150k fsyncs) — slow. We wrap the
 * whole load in a SINGLE transaction (`insertMany`), so it commits once. This is
 * the same idea as Phase 5's batch writes: amortize the per-write fixed cost by
 * grouping many writes into one transaction.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { db, initSchema, countQueries } from "../src/db.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CSV_PATH = join(__dirname, "..", "data", "dataset.csv");

initSchema();

// Start clean so re-running ingest is idempotent (no double counts).
db.exec("DELETE FROM queries;");

const raw = readFileSync(CSV_PATH, "utf-8");
const lines = raw.split("\n");

const insert = db.prepare("INSERT OR REPLACE INTO queries (query, count) VALUES (?, ?)");

// db.transaction(...) returns a function; calling it runs the body inside ONE
// transaction. Everything commits together (or rolls back together on error).
const insertMany = db.transaction((rows: [string, number][]) => {
  for (const [query, count] of rows) insert.run(query, count);
});

const rows: [string, number][] = [];
for (let i = 1; i < lines.length; i++) {
  // i = 1 to skip the "query,count" header line
  const line = lines[i];
  if (!line) continue;
  const comma = line.lastIndexOf(","); // count never contains a comma; query might in theory
  const query = line.slice(0, comma).trim();
  const count = Number(line.slice(comma + 1).trim());
  if (!query || !Number.isFinite(count)) continue;
  rows.push([query, count]);
}

insertMany(rows);

console.log(`Ingested ${countQueries()} rows into SQLite (${CSV_PATH}).`);
