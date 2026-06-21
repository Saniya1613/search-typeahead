/**
 * POST /search   body: { "query": "<text>" }
 * ───────────────────────────────────────────────────────────────────────────
 * The user committed to a search (pressed Enter / clicked a suggestion). The
 * assignment's contract:
 *   - always return a dummy response: { "message": "Searched" }
 *   - if the query exists, its count goes up
 *   - if it's new, it's created with an initial count
 *   - the increase should eventually show up in suggestions & trending
 *
 * "eventually" is the key word — the durable write is BATCHED (see batch.ts) so
 * we don't hit SQLite once per search. The trie (read index) is bumped
 * immediately inside enqueue(), so suggestions reflect the search right away;
 * only the SQLite write is deferred to the next flush.
 */

import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.ts";
import { Trie } from "../trie.ts";

export function registerSearch(app: FastifyInstance, ctx: AppContext): void {
  app.post("/search", async (request, reply) => {
    const body = request.body as { query?: unknown };
    const raw = typeof body?.query === "string" ? body.query : "";
    const query = Trie.normalize(raw);

    if (!query) {
      reply.code(400);
      return { message: "query is required" };
    }

    // Enqueue for a batched DB write. enqueue() also bumps the in-memory trie
    // immediately, so the next /suggest reflects this search even before the
    // batch is flushed to SQLite.
    ctx.batch.enqueue(query);

    return { message: "Searched" };
  });
}
