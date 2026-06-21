// api.js — the only place that talks to the backend. All paths go through the
// Vite proxy (/api -> http://localhost:3001), so there's no hardcoded host.

export async function fetchSuggestions(prefix, limit = 10) {
  const url = `/api/suggest?q=${encodeURIComponent(prefix)}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`suggest failed: ${res.status}`);
  return res.json(); // { prefix, suggestions: [{query,count}], source }
}

export async function submitSearch(query) {
  const res = await fetch("/api/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`search failed: ${res.status}`);
  return res.json(); // { message: "Searched" }
}

export async function fetchTrending(limit = 8) {
  const res = await fetch(`/api/trending?mode=enhanced&limit=${limit}`);
  if (!res.ok) throw new Error(`trending failed: ${res.status}`);
  return res.json(); // { mode, items: [{query,count,recency,score}] }
}
