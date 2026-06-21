/**
 * GET /suggest?q=<prefix>&limit=<n>
 * ───────────────────────────────────────────────────────────────────────────
 * The typeahead endpoint. Returns up to `limit` (default 10) suggestions whose
 * text starts with `q`, ordered most-popular-first.
 *
 * Behaviour required by the assignment, and where each piece is handled:
 *   - up to 10 results .......... `limit` (capped below)
 *   - start with the prefix ..... trie.suggest()
 *   - sorted by count desc ...... trie.suggest() sorts before slicing
 *   - empty / no-match / case ... handled here + Trie.normalize()
 *
 * In later phases this route gains a cache layer (Phase 4) and trending for the
 * empty-prefix case (Phase 6). For now it reads straight from the trie.
 */

import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.ts";
import { CacheCluster } from "../cache/client.ts";
import { db } from "../db.ts";

const MAX_LIMIT = 10;

// Fallback for the empty box BEFORE any recent activity exists (fresh boot):
// show the most popular queries overall so the box is never blank.
const topOverall = db.prepare("SELECT query, count FROM queries ORDER BY count DESC LIMIT ?");

export function registerSuggest(app: FastifyInstance, ctx: AppContext): void {
  app.get("/suggest", async (request) => {
    const q = typeof (request.query as any).q === "string" ? (request.query as any).q : "";
    const rawLimit = Number((request.query as any).limit);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(1, rawLimit), MAX_LIMIT) : MAX_LIMIT;

    const prefix = q.trim();
    if (!prefix) {
      // Empty box -> show what's TRENDING (recency-aware), which is what a real
      // search box does before you type.
      const items = ctx.trending.top(limit);
      if (items.length > 0) {
        const suggestions = items.map((t) => ({ query: t.query, count: t.count }));
        return { prefix: "", suggestions, source: "trending" };
      }
      // No recent activity yet -> fall back to all-time popular so it's not blank.
      const rows = topOverall.all(limit) as { query: string; count: number }[];
      return { prefix: "", suggestions: rows, source: "top-overall" };
    }

    // ── Cache-aside (Phase 4) ────────────────────────────────────────────────
    // We cache the FULL top-MAX_LIMIT (10) list per prefix under one key
    // (`suggest:<prefix>`), then slice to the caller's `limit`. One key per
    // prefix keeps invalidation simple (Phase 5/6): bump a query -> delete the
    // cache keys for its prefixes, no per-limit fan-out.
    const key = CacheCluster.key(prefix);

    const cached = await ctx.cache.get(key);
    if (cached !== null) {
      // HIT: the owning Redis node already had this prefix's answer.
      const all = JSON.parse(cached) as { query: string; count: number }[];
      return { prefix, suggestions: all.slice(0, limit), source: "cache" };
    }

    // MISS: compute from the trie (source of truth), then write back with a TTL
    // so the next request for this prefix is served from cache.
    const all = ctx.trie.suggest(prefix, MAX_LIMIT);
    await ctx.cache.set(key, JSON.stringify(all));
    return { prefix, suggestions: all.slice(0, limit), source: "trie" };
  });
}
