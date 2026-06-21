#!/usr/bin/env python3
"""
Phase 0 — Dataset generation.

We need >= 100,000 (query, count) rows where `count` is a real popularity/frequency
signal (the assignment lets us "derive counts by aggregation" from any open dataset).

We use the `wordfreq` package: a corpus of English word frequencies built from a large
mix of real-world text (web, subtitles, Wikipedia, news...). For each word it gives a
frequency in [0, 1] (how often that word appears relative to all words). We:

  1. take the top N most-frequent English words  -> these are our "search queries"
  2. convert each frequency to an integer "count" by scaling (freq * 1e9, rounded)

So `count` is "expected occurrences per billion words" — a genuine, monotonic
popularity signal. The most common word ("the") gets the highest count, rare words
get the lowest. That gives us a realistic descending-popularity distribution to rank by.

Output: data/dataset.csv  with header  `query,count`
Run:    python3 scripts/make_dataset.py
"""

import csv
import os

from wordfreq import top_n_list, word_frequency

N = 150_000          # number of words -> comfortably over the 100k minimum
SCALE = 1_000_000_000  # turn a [0,1] frequency into a readable integer count

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "data", "dataset.csv")
os.makedirs(os.path.dirname(OUT), exist_ok=True)

words = top_n_list("en", N)

rows = 0
with open(OUT, "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f)
    w.writerow(["query", "count"])
    for word in words:
        # keep it to clean alphabetic-ish queries; skip empties just in case
        if not word or "," in word:
            continue
        count = round(word_frequency(word, "en") * SCALE)
        if count <= 0:
            continue  # below our scale's resolution -> drop it
        w.writerow([word, count])
        rows += 1

print(f"Wrote {rows} rows to {os.path.relpath(OUT, HERE)}")
