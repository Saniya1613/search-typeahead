#!/usr/bin/env python3
"""
Phase 0 — Dataset generation.

We need >= 100,000 (query, count) rows where `count` is a popularity signal (the
assignment lets us "derive counts by aggregation" from any open dataset). We build
the dataset in TWO parts so it behaves like a real search box:

  PART A — single-word vocabulary (from the `wordfreq` package)
    `wordfreq` is a corpus of English word frequencies built from a large mix of
    real-world text. For each word it gives a frequency in [0, 1]; we scale that to
    an integer count = freq * 1e9. So count = "expected occurrences per billion
    words" — a genuine, monotonic popularity signal (common words rank high).

  PART B — multi-word search phrases (generated)
    A real typeahead suggests phrases like "iphone pro max", "best laptop 2026",
    "macbook air price", not just single words. We generate realistic queries by
    combining popular HEAD terms with common autocomplete CONTINUATIONS (and intent
    prefixes / years / numbers). Each phrase's count is derived from its head's
    popularity, scaled down for specificity, so a phrase always ranks below its head
    ("iphone" > "iphone pro" > "iphone pro max case") — the natural autocomplete order.

Output: data/dataset.csv  with header  `query,count`
Run:    python3 scripts/make_dataset.py
"""

import csv
import os
import random

from wordfreq import top_n_list, word_frequency

N_WORDS = 150_000      # single words -> comfortably over the 100k minimum on their own
SCALE = 1_000_000_000  # turn a [0,1] frequency into a readable integer count
random.seed(42)        # deterministic phrase counts -> reproducible dataset

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "data", "dataset.csv")
os.makedirs(os.path.dirname(OUT), exist_ok=True)

# ── Part B inputs ────────────────────────────────────────────────────────────
# Popular "head" terms people search for (products, brands, tech, everyday topics).
HEADS = [
    "iphone", "ipad", "macbook", "macbook pro", "macbook air", "airpods", "apple watch",
    "samsung galaxy", "google pixel", "oneplus", "android phone", "laptop", "gaming laptop",
    "headphones", "wireless earbuds", "smartwatch", "kindle", "playstation", "xbox",
    "nintendo switch", "graphics card", "gaming pc", "monitor", "mechanical keyboard",
    "gaming mouse", "webcam", "wifi router", "drone", "gopro", "dslr camera", "power bank",
    "smart tv", "soundbar", "bluetooth speaker", "fitness tracker", "electric scooter",
    "chatgpt", "python", "javascript", "react", "node js", "docker", "kubernetes",
    "machine learning", "data science", "system design", "leetcode", "github", "vs code",
    "linux", "aws", "excel", "figma",
    "weather", "news", "recipes", "movies", "netflix", "youtube", "spotify", "instagram",
    "amazon", "flights", "hotels", "jobs", "resume template", "online courses",
    "running shoes", "sneakers", "t shirt", "jeans", "backpack", "sunglasses", "perfume",
    "skincare", "protein powder", "yoga mat", "water bottle", "office chair", "standing desk",
    "coffee maker", "air fryer", "vacuum cleaner", "mattress", "ergonomic keyboard",
]

# Continuations that commonly follow a head in a search box, each with a rough
# popularity weight (how often that intent is searched relative to the head).
SUFFIXES = {
    "pro": 0.45, "pro max": 0.30, "max": 0.28, "mini": 0.18, "air": 0.20, "plus": 0.22,
    "ultra": 0.20, "se": 0.12, "case": 0.35, "cover": 0.22, "charger": 0.30, "cable": 0.18,
    "screen protector": 0.20, "review": 0.40, "reviews": 0.30, "price": 0.42,
    "price in india": 0.25, "specs": 0.24, "deals": 0.28, "near me": 0.38,
    "vs samsung": 0.16, "vs iphone": 0.16, "release date": 0.22, "battery life": 0.18,
    "wallpaper": 0.20, "setup": 0.15, "tutorial": 0.22, "tips": 0.16, "for sale": 0.20,
    "refurbished": 0.14, "alternatives": 0.13, "discount code": 0.12, "2025": 0.26,
    "2026": 0.30,
}

# Intent words that commonly come BEFORE a head.
PREFIXES = {"best": 0.5, "cheap": 0.3, "buy": 0.35, "top 10": 0.25, "compare": 0.18}

# Heads that take a model number (e.g. "iphone 15", "pixel 9").
NUMBERED = {"iphone": range(11, 18), "ipad": range(9, 12), "samsung galaxy": range(20, 26),
            "google pixel": range(6, 10), "oneplus": range(9, 13)}


def head_base(head: str) -> int:
    """Base popularity for a head.

    We use the RAREST token, not the most common one. A head like "macbook air"
    contains the everyday word "air" (very frequent) and the brand word "macbook"
    (rarer) — the brand token reflects how often the *product* is searched, while
    "air" would wildly inflate the count. Using the min keeps phrase counts below
    their head's single-word count, preserving the natural autocomplete order.
    """
    rarest = min(word_frequency(tok, "en") for tok in head.split())
    return max(2000, round(rarest * SCALE))  # floor so niche heads still register


def emit_phrases(writer) -> int:
    seen = set()
    n = 0

    def put(query: str, count: int):
        nonlocal n
        q = query.strip().lower()
        if q in seen or "," in q:
            return
        # skip awkward consecutive-duplicate words, e.g. "macbook pro" + "pro"
        toks = q.split()
        if any(a == b for a, b in zip(toks, toks[1:])):
            return
        seen.add(q)
        writer.writerow([q, max(1, count)])
        n += 1

    for head in HEADS:
        base = head_base(head)
        # head + continuation  (e.g. "iphone pro")
        for suf, w in SUFFIXES.items():
            put(f"{head} {suf}", round(base * w * random.uniform(0.6, 1.0)))
        # intent + head  (e.g. "best laptop")
        for pre, w in PREFIXES.items():
            put(f"{pre} {head}", round(base * w * random.uniform(0.6, 1.0)))
        # head + number  (e.g. "iphone 15")  and head + number + popular suffix
        for n_ in NUMBERED.get(head, []):
            put(f"{head} {n_}", round(base * 0.5 * random.uniform(0.6, 1.0)))
            for suf in ("pro", "pro max", "price", "case"):
                put(f"{head} {n_} {suf}", round(base * 0.18 * random.uniform(0.6, 1.0)))
    return n


# ── Write everything ─────────────────────────────────────────────────────────
words = top_n_list("en", N_WORDS)
n_words = 0
with open(OUT, "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f)
    w.writerow(["query", "count"])

    # Part A — single words
    for word in words:
        if not word or "," in word:
            continue
        count = round(word_frequency(word, "en") * SCALE)
        if count <= 0:
            continue
        w.writerow([word, count])
        n_words += 1

    # Part B — multi-word search phrases
    n_phrases = emit_phrases(w)

print(f"Wrote {n_words} words + {n_phrases} phrases = {n_words + n_phrases} rows "
      f"to {os.path.relpath(OUT, HERE)}")
