// api.js — the only place that talks to the backend.
//
// We call the API with same-origin ROOT paths (/suggest, /search, /trending).
//   - In production the backend serves both the UI and the API, so these resolve
//     directly.
//   - In dev, vite.config.js proxies these paths to the backend on :3001.
// One code path, no hardcoded host, works in both.

export async function fetchSuggestions(prefix, limit = 10) {
  const url = `/suggest?q=${encodeURIComponent(prefix)}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`suggest failed: ${res.status}`);
  return res.json(); // { prefix, suggestions: [{query,count}], source }
}

export async function submitSearch(query) {
  const res = await fetch("/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`search failed: ${res.status}`);
  return res.json(); // { message: "Searched" }
}

export async function fetchTrending(limit = 8) {
  const res = await fetch(`/trending?mode=enhanced&limit=${limit}`);
  if (!res.ok) throw new Error(`trending failed: ${res.status}`);
  return res.json(); // { mode, items: [{query,count,recency,score}] }
}
