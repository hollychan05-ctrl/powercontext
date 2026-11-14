// Pure result-normalization helpers (no SDK import), kept separate so they can be
// unit-tested without loading seekdb's native bindings.

/** seekdb-js returns nested per-query arrays for query/hybridSearch but flat arrays for get. */
export function rows(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return [value];
  return Array.isArray(value[0]) ? value[0] : value;
}

/** Flatten one seekdb result object into a stable hit list. */
export function toHits(result) {
  const ids = rows(result?.ids);
  const documents = rows(result?.documents);
  const metadatas = rows(result?.metadatas);
  const distances = rows(result?.distances);
  return ids.map((id, index) => ({
    id: String(id),
    document: documents[index] ?? null,
    metadata: metadatas[index] ?? null,
    distance: distances[index] === undefined || distances[index] === null ? null : Number(distances[index]),
  }));
}

export function validateVectors(items, dimension) {
  for (const item of items) {
    if (!Array.isArray(item.embedding) || item.embedding.length !== dimension) {
      throw new Error(`embedding for ${item.id} must be an array of ${dimension} numbers`);
    }
  }
}
