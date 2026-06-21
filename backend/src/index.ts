/**
 * index.ts — server bootstrap. Order matters:
 *   1. build the app context (init DB schema, build the trie from SQLite)
 *   2. register routes
 *   3. start listening
 */

import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
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

// In production we serve the built React app from the same server, so one
// deployable service hosts both the API and the UI. The frontend calls the API
// with same-origin root paths (/suggest, /search, ...), which match the routes
// above; any other GET falls back to index.html (single-page app).
const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, "..", "..", "frontend", "dist");
if (existsSync(distDir)) {
  await app.register(fastifyStatic, { root: distDir });
  app.setNotFoundHandler((req, reply) => {
    if (req.method === "GET" && !req.url.startsWith("/api")) {
      return reply.sendFile("index.html");
    }
    reply.code(404).send({ error: "not found" });
  });
  app.log.info(`serving frontend from ${distDir}`);
}

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
