/**
 * GET /trending?limit=<n>&mode=basic|enhanced
 * ───────────────────────────────────────────────────────────────────────────
 * Returns the top trending queries. Two modes so we can demonstrate the
 * difference the assignment asks for:
 *   - enhanced (default): recency-decay blended with popularity (TrendingRanker)
 *   - basic: rank purely by all-time count (beta = 0)
 * Same endpoint, same shape — only the ranking changes.
 */

import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.ts";
import { TrendingRanker, DEFAULT_PARAMS } from "../trending.ts";

const basicRanker = new TrendingRanker({ ...DEFAULT_PARAMS, beta: 0 });

export function registerTrending(app: FastifyInstance, ctx: AppContext): void {
  app.get("/trending", async (request) => {
    const q = request.query as { limit?: string; mode?: string };
    const limit = Math.min(Math.max(1, Number(q.limit) || 10), 20);
    const mode = q.mode === "basic" ? "basic" : "enhanced";
    const ranker = mode === "basic" ? basicRanker : ctx.trending;
    return { mode, items: ranker.top(limit) };
  });
}
