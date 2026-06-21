/**
 * ring.ts — CONSISTENT HASHING ring (written by hand, no library).
 *
 * ── The problem it solves ───────────────────────────────────────────────────
 * We have 3 cache nodes and many cache keys (one per prefix). We must decide
 * which node owns which key. The naive answer is `node = hash(key) % 3`.
 *
 * Why `% N` is bad: the moment N changes (a node dies, or we add a 4th), the
 * modulus changes for ALMOST EVERY key. hash%3 vs hash%4 disagree for most
 * keys, so nearly the whole cache is suddenly on the "wrong" node → a mass
 * cache miss → every miss stampedes the database. That's the thundering-herd
 * we want to avoid.
 *
 * ── The idea ────────────────────────────────────────────────────────────────
 * Imagine a circle of positions 0 .. 2^32-1 (hash space). We place each NODE at
 * one or more positions on the circle (by hashing the node's id). To find the
 * owner of a KEY, we hash the key to a position and walk CLOCKWISE to the first
 * node we meet. That node owns the key.
 *
 * Now if a node is removed, only the keys that used to land on ITS arc move —
 * they fall through to the next node clockwise. Every other key keeps the same
 * owner. Adding a node similarly only steals the keys on its new arc. On average
 * only ~K/N keys move when N changes, instead of nearly all of them.
 *
 * ── Virtual nodes (the part examiners poke at) ──────────────────────────────
 * If each physical node sat at just ONE point, the arcs between 3 random points
 * would be very uneven — one node could own 60% of the circle by luck. So each
 * physical node is hashed to MANY positions (VNODES of them, e.g. 150). Those
 * 150 little arcs are scattered around the circle and average out, so each
 * physical node ends up owning ~1/3 of the space. More vnodes ⇒ smoother
 * distribution and smaller wobble when a node joins/leaves.
 *
 * Vocabulary recap for the viva:
 *   hash space  = the circle [0, 2^32)
 *   virtual node = one (position, physicalNodeId) point on the circle
 *   getNode(key) = hash key → binary-search clockwise → owning physical node
 */

/**
 * A small, fast, well-spread 32-bit non-cryptographic hash. We don't need crypto
 * strength — we need cheap, deterministic, UNIFORM output so both keys and node
 * positions scatter evenly around the circle (uneven hashing = uneven load, which
 * defeats the whole point of virtual nodes).
 *
 * Two stages:
 *   1. FNV-1a accumulates the bytes into a 32-bit value.
 *   2. fmix32 (the finalizer from MurmurHash3) avalanches the bits — flipping
 *      one input bit flips ~half the output bits. Plain FNV-1a has weak
 *      avalanche on the trailing bytes, so "cache-a#1" / "cache-a#2" would land
 *      in nearly the same spot and the ring would clump. The finalizer fixes
 *      that; with it, 150 vnodes/node gives a near-even split (see ringtest).
 */
export function fnv1a(str: string): number {
  let h = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    // h *= 16777619 (FNV prime), expressed as shifts to stay inside 32 bits
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  // fmix32 finalizer: pure bit-avalanche, no new information, just better spread.
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

interface VNode {
  pos: number; // position on the circle [0, 2^32)
  node: string; // id of the physical node this virtual point belongs to
}

export class HashRing {
  private ring: VNode[] = []; // kept sorted by `pos` so we can binary-search
  private nodes = new Set<string>();
  private readonly vnodes: number;

  constructor(nodeIds: string[] = [], vnodesPerNode = 150) {
    this.vnodes = vnodesPerNode;
    for (const id of nodeIds) this.addNode(id);
  }

  /** Place a physical node on the circle at `vnodes` hashed positions. */
  addNode(id: string): void {
    if (this.nodes.has(id)) return;
    this.nodes.add(id);
    for (let i = 0; i < this.vnodes; i++) {
      // Distinct label per virtual point so they hash to different positions.
      this.ring.push({ pos: fnv1a(`${id}#${i}`), node: id });
    }
    this.ring.sort((a, b) => a.pos - b.pos);
  }

  /** Remove a physical node; only its arcs' keys move (to the next node CW). */
  removeNode(id: string): void {
    if (!this.nodes.has(id)) return;
    this.nodes.delete(id);
    this.ring = this.ring.filter((v) => v.node !== id);
    // already sorted after a filter (relative order preserved)
  }

  get nodeCount(): number {
    return this.nodes.size;
  }

  /**
   * Owner of `key`: hash it, then walk clockwise to the first virtual node at a
   * position >= the key's hash. We find that first-greater-or-equal entry with a
   * binary search (O(log V)); if we run off the end, we wrap to ring[0] — that's
   * the "circle" closing.
   */
  getNode(key: string): string | null {
    if (this.ring.length === 0) return null;
    const h = fnv1a(key);

    let lo = 0;
    let hi = this.ring.length - 1;
    // Find the smallest index whose pos >= h.
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.ring[mid].pos < h) lo = mid + 1;
      else hi = mid;
    }
    // If h is greater than every position, wrap around to the first node.
    const idx = this.ring[lo].pos >= h ? lo : 0;
    return this.ring[idx].node;
  }

  /**
   * Diagnostics for the viva/demo: send a sample of keys through getNode and
   * report how the load splits across physical nodes. Should be ~even.
   */
  distribution(sampleKeys: string[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const id of this.nodes) counts[id] = 0;
    for (const k of sampleKeys) {
      const n = this.getNode(k);
      if (n) counts[n]++;
    }
    return counts;
  }
}
