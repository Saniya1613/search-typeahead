/**
 * Cache inspection routes — required by the assignment ("Debug cache routing")
 * and very useful to demonstrate that consistent hashing actually works.
 *
 *   GET /cache/debug?prefix=<x>   -> which node owns this prefix, and is it cached?
 *   GET /cache/ring               -> load distribution of a key sample across nodes
 *   GET /metrics                  -> cache hit rate + counters
 */

import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.ts";
import { db } from "../db.ts";

export function registerCacheRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Assignment-mandated debug endpoint: "Shows which cache node is responsible
  // for the prefix and whether it is a hit or miss."
  app.get("/cache/debug", async (request, reply) => {
    const prefix = String((request.query as any).prefix ?? "").trim().toLowerCase();
    if (!prefix) {
      reply.code(400);
      return { error: "prefix is required" };
    }
    const info = await ctx.cache.debug(prefix);
    return { prefix, ...info };
  });

  // Proof that the ring spreads keys ~evenly: route a big sample of real
  // prefixes through getNode and report the per-node counts (should be ~1/3 each).
  app.get("/cache/ring", async () => {
    const rows = db.prepare("SELECT query FROM queries LIMIT 20000").all() as { query: string }[];
    // Use 1-3 char prefixes of real queries as the sample keyspace.
    const prefixes = new Set<string>();
    for (const r of rows) {
      const q = r.query;
      if (q.length >= 1) prefixes.add(q.slice(0, 1));
      if (q.length >= 2) prefixes.add(q.slice(0, 2));
      if (q.length >= 3) prefixes.add(q.slice(0, 3));
    }
    const sample = [...prefixes];
    const dist = ctx.cache.distribution(sample);
    return { totalKeys: sample.length, perNode: dist };
  });

  app.get("/metrics", async () => {
    const b = ctx.batch.stats();
    return {
      cache: {
        hits: ctx.cache.hits,
        misses: ctx.cache.misses,
        hitRate: Number(ctx.cache.hitRate().toFixed(3)),
      },
      batch: {
        ...b,
        // The headline number: how many DB writes we AVOIDED by batching.
        // Every accepted event would be >=1 write unbatched; we did `dbWrites`.
        writeReduction:
          b.enqueued === 0 ? 0 : Number((1 - b.dbWrites / b.enqueued).toFixed(3)),
      },
      queries: ctx.trie.wordCount,
    };
  });
}
