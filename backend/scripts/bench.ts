/**
 * bench.ts — non-functional measurement: /suggest latency + cache hit rate.
 *
 * Run (server must be up):  npm run bench
 *
 * What it does:
 *  1. pulls a sample of real prefixes from SQLite
 *  2. fires N requests at /suggest, deliberately REUSING prefixes so the cache
 *     gets exercised (a realistic workload — popular prefixes repeat)
 *  3. records each request's latency, then reports p50/p95/p99
 *  4. reads /metrics to report the achieved cache hit rate
 *
 * p95 = "95% of requests were at least this fast". We care about the tail, not
 * just the average, because the slow 5% is what users actually feel.
 */

import { db } from "../src/db.ts";

const BASE = process.env.BASE ?? "http://localhost:3001";
const N = Number(process.env.N ?? 5000);

// Build a pool of prefixes from real queries (1-4 chars). We sample WITH heavy
// repetition so the same prefixes recur — that's what makes the cache useful.
const rows = db.prepare("SELECT query FROM queries ORDER BY count DESC LIMIT 2000").all() as {
  query: string;
}[];
const pool: string[] = [];
for (const r of rows) {
  const q = r.query;
  for (const len of [1, 2, 3, 4]) {
    if (q.length >= len) pool.push(q.slice(0, len));
  }
}

function pick(): string {
  // Zipf-ish: bias toward the front of the pool (popular prefixes) so a small
  // set of hot prefixes dominates — realistic, and cache-friendly.
  const r = Math.random() ** 2; // squashes toward 0 -> front of the array
  return pool[Math.floor(r * pool.length)];
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function main() {
  // Warm-up (also primes the cache for hot prefixes).
  for (let i = 0; i < 200; i++) await fetch(`${BASE}/suggest?q=${encodeURIComponent(pick())}`);

  const latencies: number[] = [];
  const t0 = performance.now();
  for (let i = 0; i < N; i++) {
    const q = pick();
    const start = performance.now();
    await fetch(`${BASE}/suggest?q=${encodeURIComponent(q)}`);
    latencies.push(performance.now() - start);
  }
  const wall = performance.now() - t0;

  latencies.sort((a, b) => a - b);
  const metrics = await (await fetch(`${BASE}/metrics`)).json();

  console.log(`\n=== /suggest benchmark (${N} requests) ===`);
  console.log(`throughput   : ${(N / (wall / 1000)).toFixed(0)} req/s (single client, serial)`);
  console.log(`latency  p50 : ${percentile(latencies, 50).toFixed(2)} ms`);
  console.log(`latency  p95 : ${percentile(latencies, 95).toFixed(2)} ms`);
  console.log(`latency  p99 : ${percentile(latencies, 99).toFixed(2)} ms`);
  console.log(`latency  max : ${latencies[latencies.length - 1].toFixed(2)} ms`);
  console.log(`cache hits   : ${metrics.cache.hits}`);
  console.log(`cache misses : ${metrics.cache.misses}`);
  console.log(`cache hitRate: ${(metrics.cache.hitRate * 100).toFixed(1)}%`);
  process.exit(0);
}

main();
