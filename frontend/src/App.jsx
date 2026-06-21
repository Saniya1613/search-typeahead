import { useEffect, useRef, useState, useCallback } from "react";
import { fetchSuggestions, submitSearch, fetchTrending } from "./api.js";

const DEBOUNCE_MS = 300;

export default function App() {
  const [input, setInput] = useState("");
  const [suggestions, setSuggestions] = useState([]);
  const [source, setSource] = useState(null); // "cache" | "trie" | "trending"
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [activeIndex, setActiveIndex] = useState(-1); // keyboard-highlighted row
  const [open, setOpen] = useState(false);
  const [searchResult, setSearchResult] = useState(null); // dummy { message } + query
  const [trending, setTrending] = useState([]);

  // Used to discard out-of-order responses: a slow request for "ip" must not
  // overwrite a newer, faster response for "iph". We only accept a response if
  // its id is still the latest one we issued.
  const reqId = useRef(0);

  // Load trending once on mount (and it's what we show when the box is empty).
  useEffect(() => {
    fetchTrending(8)
      .then((d) => setTrending(d.items))
      .catch(() => setTrending([]));
  }, []);

  // ── Debounced suggestion fetching ──────────────────────────────────────────
  // We DON'T call the API on every keystroke. We wait DEBOUNCE_MS after the last
  // keystroke, so typing "iphone" fires one request, not six. The cleanup
  // clears the pending timer whenever `input` changes again before it fires.
  useEffect(() => {
    const q = input.trim();
    if (!q) {
      setSuggestions([]);
      setSource(null);
      setActiveIndex(-1);
      return;
    }
    const timer = setTimeout(async () => {
      const myId = ++reqId.current;
      setLoading(true);
      setError(null);
      try {
        const data = await fetchSuggestions(q, 10);
        if (myId !== reqId.current) return; // a newer request superseded us
        setSuggestions(data.suggestions);
        setSource(data.source);
        setActiveIndex(-1);
        setOpen(true);
      } catch (e) {
        if (myId !== reqId.current) return;
        setError("Could not load suggestions. Is the backend running?");
        setSuggestions([]);
      } finally {
        if (myId === reqId.current) setLoading(false);
      }
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer); // cancel if input changes before it fires
  }, [input]);

  // Commit a search (Enter or click). Updates the dummy result + refreshes
  // trending so a just-searched query can climb the trending list.
  const runSearch = useCallback(async (query) => {
    const q = (query ?? "").trim();
    if (!q) return;
    setOpen(false);
    try {
      const res = await submitSearch(q);
      setSearchResult({ query: q, message: res.message });
      fetchTrending(8).then((d) => setTrending(d.items)).catch(() => {});
    } catch {
      setError("Search request failed.");
    }
  }, []);

  // ── Keyboard navigation on the dropdown ────────────────────────────────────
  const onKeyDown = (e) => {
    if (!open || suggestions.length === 0) {
      if (e.key === "Enter") runSearch(input);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % suggestions.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      // Enter on a highlighted suggestion searches it; otherwise the raw input.
      const chosen = activeIndex >= 0 ? suggestions[activeIndex].query : input;
      setInput(chosen);
      runSearch(chosen);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  const showTrendingPanel = !input.trim();

  return (
    <div className="page">
      <header>
        <h1>Search Typeahead</h1>
        <p className="sub">
          Trie suggestions · consistent-hashing cache · batched writes · trending
        </p>
      </header>

      <div className="searchbox">
        <input
          autoFocus
          type="text"
          value={input}
          placeholder="Start typing… (e.g. “iph”, “app”, “car”)"
          onChange={(e) => {
            setInput(e.target.value);
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
          onFocus={() => setOpen(true)}
          aria-label="Search"
        />
        <button onClick={() => runSearch(input)} disabled={!input.trim()}>
          Search
        </button>

        {/* Suggestion dropdown */}
        {open && input.trim() && (
          <ul className="dropdown">
            {loading && <li className="state">Loading…</li>}
            {!loading && error && <li className="state error">{error}</li>}
            {!loading && !error && suggestions.length === 0 && (
              <li className="state">No suggestions</li>
            )}
            {!loading &&
              !error &&
              suggestions.map((s, i) => (
                <li
                  key={s.query}
                  className={i === activeIndex ? "row active" : "row"}
                  onMouseDown={(e) => {
                    e.preventDefault(); // keep input focus
                    setInput(s.query);
                    runSearch(s.query);
                  }}
                  onMouseEnter={() => setActiveIndex(i)}
                >
                  <span className="q">{s.query}</span>
                  <span className="count">{s.count.toLocaleString()}</span>
                </li>
              ))}
            {!loading && !error && source && (
              <li className="source">served from: {source}</li>
            )}
          </ul>
        )}
      </div>

      {/* Dummy search response */}
      {searchResult && (
        <div className="result">
          <strong>{searchResult.message}</strong>: “{searchResult.query}”
        </div>
      )}

      {/* Trending section — also what the empty box would show */}
      <section className="trending">
        <h2>{showTrendingPanel ? "Trending now" : "Trending"}</h2>
        {trending.length === 0 ? (
          <p className="muted">No trending data yet — run a few searches.</p>
        ) : (
          <ol>
            {trending.map((t) => (
              <li key={t.query}>
                <button className="link" onClick={() => { setInput(t.query); runSearch(t.query); }}>
                  {t.query}
                </button>
                <span className="muted"> · count {t.count.toLocaleString()}</span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
