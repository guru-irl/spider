// ─────────────────────────────────────────────────────────
// Generalized RRF fusion + proximity rerank (ported from
// context-mode's store.ts). Pure — no DB/executor/store imports.
// ─────────────────────────────────────────────────────────

import { STOPWORDS, findAllPositions, findMinSpan, countAdjacentPairs } from "./fts-query";

export interface Ranked {
  key: string;
}

export function rrfFuse<T extends Ranked>(
  lists: T[][],
  opts?: { k?: number },
): Array<T & { rrfScore: number }> {
  const K = opts?.k ?? 60;
  const map = new Map<string, { item: T; score: number }>();
  for (const list of lists) {
    for (const [i, item] of list.entries()) {
      const inc = 1 / (K + i + 1);
      const ex = map.get(item.key);
      if (ex) ex.score += inc;
      else map.set(item.key, { item, score: inc });
    }
  }
  return Array.from(map.values())
    .sort((a, b) => b.score - a.score)
    .map(({ item, score }) => ({ ...item, rrfScore: score }));
}

/**
 * Reranks candidates by title-match boost + content proximity/phrase-frequency
 * signals. Ported verbatim (math-wise) from context-mode's
 * `#applyProximityReranking` — converted from a private class method into a
 * free function operating on a generic item shape.
 */
export function proximityRerank<
  T extends { key: string; title: string; content: string; contentType?: "code" | "prose"; rank?: number },
>(items: T[], query: string): T[] {
  const allTerms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length >= 2);
  // Exclude stopwords from proximity/title scoring — they match everywhere
  // and inflate boosts for irrelevant chunks. Keep all terms as fallback.
  const filtered = allTerms.filter((w) => !STOPWORDS.has(w));
  const terms = filtered.length > 0 ? filtered : allTerms;

  return items
    .map((r) => {
      // Title-match boost: query terms found in the chunk title get a boost.
      // Code chunks get a stronger title boost (function/class names are high
      // signal) while prose chunks get a moderate one (headings are useful but
      // body carries more weight).
      const titleLower = r.title.toLowerCase();
      const titleHits = terms.filter((t) => titleLower.includes(t)).length;
      const titleWeight = r.contentType === "code" ? 0.6 : 0.3;
      const titleBoost = titleHits > 0 ? titleWeight * (titleHits / terms.length) : 0;

      // Proximity boost for multi-term queries. minSpan picks the single
      // tightest window — frequency doesn't move it, so a long doc with one
      // tight occurrence outranks a short doc with several. Phrase-frequency
      // reward layers a saturating frequency signal on top: cap 0.5 (below
      // proximity max ≈1.0, in title-boost range), saturates at 4 hits.
      let proximityBoost = 0;
      let phraseBoost = 0;
      if (terms.length >= 2) {
        const content = r.content.toLowerCase();
        const positions = terms.map((t) => findAllPositions(content, t));

        if (!positions.some((p) => p.length === 0)) {
          const minSpan = findMinSpan(positions);
          proximityBoost = 1 / (1 + minSpan / Math.max(content.length, 1));

          const adjacentPairs = countAdjacentPairs(positions, terms);
          phraseBoost = 0.5 * Math.min(1, adjacentPairs / 4);
        }
      }

      return { result: r, boost: titleBoost + proximityBoost + phraseBoost };
    })
    .sort((a, b) => b.boost - a.boost || (a.result.rank ?? 0) - (b.result.rank ?? 0))
    .map(({ result }) => result);
}
