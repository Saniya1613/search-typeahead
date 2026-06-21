/**
 * index.ts — server bootstrap. Order matters:
 *   1. build the app context (init DB schema, build the trie from SQLite)
 *   2. register routes
 *   3. start listening
 */

import Fastify from "fastify";
import cors from "@fastify/cors";
import { createContext } from "./context.ts";
import { registerSuggest } from "./routes/suggest.ts";
import { registerSearch } from "./routes/search.ts";
import { registerCacheRoutes } from "./routes/cache.ts";
import { registerTrending } from "./routes/trending.ts";

const PORT = Number(process.env.PORT ?? 3001);

const app = Fastify({ logger: { level: "info" } });
await app.register(cors, { origin: true }); // let the Vite dev frontend call us

const ctx = createContext();

registerSuggest(app, ctx);
registerSearch(app, ctx);
registerCacheRoutes(app, ctx);
registerTrending(app, ctx);

app.get("/health", async () => ({ ok: true, queries: ctx.trie.wordCount }));

// Graceful shutdown: drain the batch buffer to SQLite and close Redis so we
// don't drop the last (un-flushed) window of search counts on Ctrl-C.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    app.log.info(`${sig} received, flushing batch + closing cache...`);
    await ctx.batch.stop();
    await ctx.cache.quit();
    await app.close();
    process.exit(0);
  });
}

try {
  await app.listen({ port: PORT, host: "0.0.0.0" });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
