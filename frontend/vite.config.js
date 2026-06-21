import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, proxy the backend API paths to Fastify on :3001 so the frontend can
// use same-origin root paths (/suggest, /search, ...) — the exact paths that work
// in production when the backend serves the built app. One set of paths, both modes.
const API = "^/(suggest|search|trending|cache|metrics|health)";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      [API]: { target: "http://localhost:3001", changeOrigin: true },
    },
  },
});
