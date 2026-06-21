/**
 * trie.ts — the in-memory PREFIX INDEX. This is the heart of "typeahead".
 *
 * ── What is a trie? ─────────────────────────────────────────────────────────
 * A trie (a.k.a. prefix tree) is a tree where each EDGE is labelled with one
 * character and each PATH from the root spells out a prefix. Words that share a
 * prefix share the same path until they diverge.
 *
 *   Inserting "car", "cart", "cat":
 *
 *        (root)
 *          └─ c
 *             └─ a
 *                ├─ r   ← end of "car"  (count stored here)
 *                │  └─ t ← end of "cart"
 *                └─ t   ← end of "cat"
 *
 * ── Why a trie instead of scanning SQLite each keystroke? ───────────────────
 * To answer "what completes 'car'?" we walk 3 edges (c→a→r) — that's
 * O(length of the prefix), INDEPENDENT of how many queries we store. A SQL
 * `LIKE 'car%'` would scan/scan-index over the whole table on every keystroke,
 * and we get a keystroke every few hundred ms per user. The trie turns "find
 * the prefix" into a tiny constant-ish walk.
 *
 * Trade-off (be ready to defend): the trie lives in RAM and must be rebuilt on
 * boot from SQLite. We pay memory + startup cost to buy fast reads. The
 * alternative — a sorted array + binary search — also gives fast prefix range
 * lookup, but inserting/updating a count means shifting elements (O(n)); the
 * trie updates in O(word length). We expect live count updates, so the trie wins.
 */

export interface Suggestion {
  query: string;
  count: number;
}

class TrieNode {
  // children: one entry per next character. A Map (not a 26-slot array) because
  // our queries can contain digits, apostrophes, etc. — not just a-z.
  children = new Map<string, TrieNode>();
  // If this node terminates a complete query, `count` is that query's popularity.
  // undefined means "this node is only an internal prefix, not a stored word".
  count: number | undefined = undefined;
  // The exact stored spelling of the word ending here (so we don't have to
  // rebuild the string by walking back up). Only set on terminal nodes.
  word: string | undefined = undefined;
}

export class Trie {
  private root = new TrieNode();
  private size = 0; // number of distinct stored queries

  /** Normalize so "iPhone", "IPHONE", " iphone " all map to one key. */
  static normalize(s: string): string {
    return s.trim().toLowerCase();
  }

  get wordCount(): number {
    return this.size;
  }

  /**
   * Insert (or overwrite) a query with an absolute count.
   * Walk one node per character, creating nodes as needed.  O(word length).
   */
  insert(query: string, count: number): void {
    const key = Trie.normalize(query);
    if (!key) return;
    let node = this.root;
    for (const ch of key) {
      let next = node.children.get(ch);
      if (!next) {
        next = new TrieNode();
        node.children.set(ch, next);
      }
      node = next;
    }
    if (node.count === undefined) this.size++; // first time this word becomes terminal
    node.count = count;
    node.word = key;
  }

  /**
   * Add `delta` to a query's count (used by /search). If the query is new, it
   * gets created with that delta. Returns the new count.  O(word length).
   */
  increment(query: string, delta = 1): number {
    const key = Trie.normalize(query);
    let node = this.root;
    for (const ch of key) {
      let next = node.children.get(ch);
      if (!next) {
        next = new TrieNode();
        node.children.set(ch, next);
      }
      node = next;
    }
    if (node.count === undefined) {
      this.size++;
      node.count = 0;
      node.word = key;
    }
    node.count += delta;
    return node.count;
  }

  /** Walk from root to the node representing `prefix`, or null if no such path. */
  private findNode(prefix: string): TrieNode | null {
    let node = this.root;
    for (const ch of prefix) {
      const next = node.children.get(ch);
      if (!next) return null; // prefix not present — no suggestions
      node = next;
    }
    return node;
  }

  /**
   * Depth-first collect every complete query in the subtree rooted at `node`.
   * We gather ALL matches first, then sort by count — see the complexity note
   * in the comment at the top of `suggest`.
   */
  private collect(node: TrieNode, out: Suggestion[]): void {
    if (node.count !== undefined && node.word !== undefined) {
      out.push({ query: node.word, count: node.count });
    }
    for (const child of node.children.values()) {
      this.collect(child, out);
    }
  }

  /**
   * The typeahead query.  Returns up to `limit` suggestions that start with
   * `prefix`, sorted by count descending (most popular first).
   *
   * Complexity: O(P) to reach the prefix node (P = prefix length), then O(M)
   * to collect its M descendants, then O(M log M) to sort. M is small for
   * longer prefixes and large for 1-char prefixes — which is exactly why the
   * cache (Phase 4) sits in front of this, and why empty input is handled
   * separately (trending), never as "collect all 150k then sort".
   */
  suggest(prefix: string, limit = 10): Suggestion[] {
    const key = Trie.normalize(prefix);
    if (!key) return []; // empty prefix is handled by the trending path, not here
    const node = this.findNode(key);
    if (!node) return []; // graceful: unknown prefix -> empty list, not an error

    const matches: Suggestion[] = [];
    this.collect(node, matches);
    matches.sort((a, b) => b.count - a.count || a.query.localeCompare(b.query));
    return matches.slice(0, limit);
  }
}
