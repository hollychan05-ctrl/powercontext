// Pure retrieval-quality metrics (Recall@K, nDCG@K).
//
// Kept dependency-free so the backend unit test can exercise them under Node, while
// the browser imports the very same module (the app's eval panel must not drift from
// what the tests verify).

/** Fraction of the labeled-relevant ids that appear in the first K ranked ids. */
export function recallAtK(ranked, relevant, k) {
  if (!relevant || relevant.size === 0) return null;
  const top = ranked.slice(0, k);
  let hit = 0;
  for (const id of top) if (relevant.has(id)) hit += 1;
  return hit / relevant.size;
}

/** Binary-gain nDCG@K against the ideal ordering of the relevant set. */
export function ndcgAtK(ranked, relevant, k) {
  if (!relevant || relevant.size === 0) return null;
  const dcg = ranked
    .slice(0, k)
    .reduce((sum, id, index) => sum + (relevant.has(id) ? 1 / Math.log2(index + 2) : 0), 0);
  const ideal = Array.from({ length: Math.min(relevant.size, k) }).reduce(
    (sum, _, index) => sum + 1 / Math.log2(index + 2),
    0,
  );
  return ideal === 0 ? null : dcg / ideal;
}

/** Coerce a list of ids (or `{id}` objects) into a plain string array. */
export function rankedIds(hits) {
  return (hits ?? []).map((hit) => String(typeof hit === "object" && hit !== null ? hit.id : hit));
}
