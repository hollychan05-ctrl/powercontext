// seekdb access layer.
//
// The browser owns embedding (Transformers.js / WebGPU+WASM). This process only stores
// vectors + text and runs the *hybrid* retrieval inside seekdb: one `hybridSearch()` call
// fuses a full-text channel (`whereDocument.$contains`) and a dense-vector channel
// (`knn.queryEmbeddings`) with Reciprocal Rank Fusion. The two channels are never fetched
// separately and merged in application code.

import { SeekdbClient, Schema, FulltextIndexConfig, VectorIndexConfig } from "seekdb";

import { config, describeTarget } from "./config.mjs";
import { rows, toHits, validateVectors } from "./rows.mjs";

let client = null;
let collection = null;

function buildClient() {
  if (config.mode === "server") {
    const args = {
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
    };
    if (config.tenant) args.tenant = config.tenant;
    return new SeekdbClient(args);
  }
  return new SeekdbClient({ path: config.path, database: config.database });
}

function buildSchema() {
  // `embeddingFunction: null` disables server-side vectorization: every vector written or
  // queried here was produced by the browser. A full-text index is required for the
  // keyword channel of `hybridSearch`.
  return new Schema()
    .createIndex(new FulltextIndexConfig())
    .createIndex(
      new VectorIndexConfig({
        hnsw: { dimension: config.dimension, distance: "cosine" },
        embeddingFunction: null,
      }),
    );
}

export async function ensureReady() {
  if (collection) return collection;
  client = buildClient();
  collection = await client.getOrCreateCollection({
    name: config.collection,
    schema: buildSchema(),
    // Explicitly null: the browser owns embedding. The collection metadata stored in
    // seekdb still records a 'default-embed' embedding function, and without this
    // override the SDK tries to resolve it from its local registry (which fails when
    // @seekdb/default-embed is not installed) even though we never use server-side
    // vectorization.
    embeddingFunction: null,
  });
  return collection;
}

/** Insert or update documents. Existing ids are replaced in place (incremental writes). */
export async function ingest(items) {
  if (!Array.isArray(items) || items.length === 0) return { upserted: 0 };
  validateVectors(items, config.dimension);
  const target = await ensureReady();
  await target.upsert({
    ids: items.map((item) => String(item.id)),
    documents: items.map((item) => String(item.text)),
    embeddings: items.map((item) => item.embedding.map(Number)),
    metadatas: items.map((item) => ({ ...(item.metadata ?? {}), id: String(item.id) })),
  });
  // A vector index is not updated by the write itself: without an explicit refresh the
  // freshly written rows stay invisible to knn/hybridSearch (this is exactly the
  // "incremental write + index refresh" behaviour the task asks for).
  const refreshed = await refreshIndex(target);
  return { upserted: items.length, indexRefreshed: refreshed };
}

/** Ask seekdb to make the latest writes searchable. Returns whether it happened. */
async function refreshIndex(target) {
  if (typeof target?.refresh_index !== "function") return false;
  await target.refresh_index();
  return true;
}

/** Hybrid retrieval: full-text + dense vector, fused by seekdb RRF. */
export async function search({ query, embedding, nResults = 8, mode = "hybrid" }) {
  const target = await ensureReady();
  const limit = Math.max(1, Math.min(Number(nResults) || 8, 50));
  const pool = Math.max(limit * 4, 32);

  if (mode === "vector") {
    const result = await target.query({
      queryEmbeddings: [embedding.map(Number)],
      nResults: limit,
      include: ["documents", "metadatas", "distances"],
    });
    return { mode: "vector", hits: toHits(result) };
  }

  const options = {
    knn: { queryEmbeddings: [embedding.map(Number)], nResults: pool },
    rank: { rrf: {} },
    nResults: limit,
    include: ["documents", "metadatas", "distances"],
  };
  if (typeof query === "string" && query.trim()) {
    options.query = { whereDocument: { $contains: query.trim() }, nResults: pool };
  }
  const result = await target.hybridSearch(options);
  return { mode: "hybrid", hits: toHits(result) };
}

/**
 * Confirm a just-written document is retrievable (post-write index visibility).
 * Two independent facts are reported:
 *   * `indexed` — the row is really in the collection after the write;
 *   * `rank`    — where it lands when the collection is queried with its own vector
 *                (a document is not necessarily its own nearest neighbour, so a high
 *                rank is normal and must not be reported as a failure).
 */
export async function verify(id, embedding) {
  const target = await ensureReady();
  const key = String(id);
  const stored = await target.get({ ids: [key], limit: 1 }).catch(() => null);
  const indexed = rows(stored?.ids).map(String).includes(key);

  // Ask for the whole collection so the true rank is visible, not just the top 5.
  const total = typeof target.count === "function" ? await target.count() : 50;
  const result = await search({ query: "", embedding, nResults: Math.max(5, Number(total) || 50), mode: "vector" });
  const rank = result.hits.findIndex((hit) => hit.id === key);
  return {
    id: key,
    indexed,
    rank: rank < 0 ? null : rank + 1,
    hit: rank < 0 ? null : result.hits[rank],
  };
}

export async function stats() {
  const target = await ensureReady();
  let count = null;
  if (typeof target.count === "function") {
    count = await target.count();
  } else {
    const all = await target.get({ limit: 100_000, include: ["metadatas"] });
    count = rows(all?.ids).length;
  }
  return {
    target: describeTarget(),
    collection: config.collection,
    dimension: config.dimension,
    count: Number(count ?? 0),
  };
}

export async function reset() {
  const target = await ensureReady();
  // A `whereDocument` delete can silently match nothing, so always fall back to an
  // explicit delete by id list to make the collection really empty.
  await target.delete({ whereDocument: { $contains: "" } }).catch(() => {});
  const all = await target.get({ limit: 100_000 });
  const ids = rows(all?.ids).map(String);
  if (ids.length) await target.delete({ ids });
  await refreshIndex(target);
  return { cleared: true, deleted: ids.length };
}

export async function close() {
  if (client && typeof client.close === "function") await client.close();
  client = null;
  collection = null;
}

export { config };
