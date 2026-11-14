// seekdb access layer for the session-state service.
//
// Two collections live in the same seekdb / OceanBase instance:
//
//   <STATE_COLLECTION>   one row per session  — the authoritative game state
//   <MEMORY_COLLECTION>  one row per interaction — the memory log (read + write
//                        records), embedded so it can be searched semantically
//
// Both collections carry a full-text index *and* an HNSW vector index, so the
// service can answer both "show me everything this session did" (metadata +
// full text) and "what did I say about the moon gate three turns ago"
// (vector search) from the same database.

import { SeekdbClient, Schema, FulltextIndexConfig, VectorIndexConfig } from "seekdb";

import { config, describeTarget } from "./config.mjs";
import { embed, embedOne, embeddingsEnabled } from "./embeddings.mjs";
import { memoryToDocument, stateToDocument } from "./state.mjs";

let client = null;
let stateCollection = null;
let memoryCollection = null;

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
  return new Schema()
    .createIndex(new FulltextIndexConfig())
    .createIndex(
      new VectorIndexConfig({
        hnsw: { dimension: config.embeddingDimension, distance: "cosine" },
        // The service embeds explicitly; the server must never try to vectorize.
        embeddingFunction: null,
      }),
    );
}

/** Open (or create) both collections. Safe to call repeatedly. */
export async function ensureReady() {
  if (stateCollection && memoryCollection) return { stateCollection, memoryCollection };
  client = buildClient();
  const schema = buildSchema();
  stateCollection = await client.getOrCreateCollection({
    name: config.stateCollection,
    schema,
    embeddingFunction: null,
  });
  memoryCollection = await client.getOrCreateCollection({
    name: config.memoryCollection,
    schema,
    embeddingFunction: null,
  });
  return { stateCollection, memoryCollection };
}

/** A vector index is not updated by the write itself — refresh explicitly. */
async function refreshIndex(target) {
  if (typeof target?.refresh_index !== "function") return false;
  await target.refresh_index();
  return true;
}

/** Read one session row. Returns null when the session is unknown. */
export async function readState(sessionId) {
  const { stateCollection: target } = await ensureReady();
  const key = String(sessionId);
  const result = await target.get({ ids: [key], limit: 1, include: ["documents", "metadatas"] });
  const ids = result?.ids ?? [];
  if (!ids.length) return null;
  const index = ids.map(String).indexOf(key);
  if (index < 0) return null;

  let state = null;
  try {
    state = JSON.parse(result.documents?.[index] ?? "null");
  } catch {
    state = null;
  }
  return {
    state,
    metadata: result.metadatas?.[index] ?? {},
    document: result.documents?.[index] ?? "",
  };
}

/** Write (upsert) the session state. */
export async function writeState(sessionId, state, extra = {}) {
  const { stateCollection: target } = await ensureReady();
  const key = String(sessionId);
  const document = JSON.stringify(state);
  const searchable = stateToDocument(key, state);
  const vector = embeddingsEnabled() ? await embedOne(searchable) : null;

  const payload = {
    ids: [key],
    documents: [document],
    metadatas: [
      {
        kind: "session_state",
        session_id: key,
        turn: Number(state?.turn ?? 0),
        location: String(state?.location ?? ""),
        hp: Number(state?.hp ?? 0),
        gold: Number(state?.gold ?? 0),
        updated_at: new Date().toISOString(),
        ...extra,
      },
    ],
  };
  if (vector) payload.embeddings = [vector];

  await target.upsert(payload);
  await refreshIndex(target);
  return { id: key, embedded: Boolean(vector) };
}

/** Append one interaction to the memory log. */
export async function appendMemory(entry) {
  const { memoryCollection: target } = await ensureReady();
  const id = `${entry.session_id}:${String(entry.seq).padStart(6, "0")}`;
  const document = memoryToDocument(entry);
  const vector = embeddingsEnabled() ? await embedOne(document) : null;

  const payload = {
    ids: [id],
    documents: [document],
    metadatas: [
      {
        kind: "memory",
        session_id: entry.session_id,
        seq: entry.seq,
        op: entry.op,
        turn: entry.turn,
        location: entry.location ?? "",
        player_input: (entry.player_input ?? "").slice(0, 500),
        summary: (entry.summary ?? "").slice(0, 1000),
        delta: (entry.delta ?? "").slice(0, 500),
        created_at: new Date().toISOString(),
      },
    ],
  };
  if (vector) payload.embeddings = [vector];

  await target.upsert(payload);
  await refreshIndex(target);
  return { id, embedded: Boolean(vector) };
}

/**
 * Read the memory log of a session.
 *
 * `query` switches the channel: a non-empty query uses seekdb's *hybrid*
 * search (full text + vector, fused with RRF), otherwise the entries are
 * listed by id order.
 */
export async function readMemory(sessionId, { limit = 20, query = "" } = {}) {
  const { memoryCollection: target } = await ensureReady();
  const cap = Math.max(1, Math.min(Number(limit) || 20, 200));

  if (query && embeddingsEnabled()) {
    const vector = await embedOne(query);
    const result = await target.hybridSearch({
      query: {
        where: { session_id: String(sessionId) },
        whereDocument: { $contains: query },
        nResults: cap * 4,
      },
      knn: {
        queryEmbeddings: [vector],
        where: { session_id: String(sessionId) },
        nResults: cap * 4,
      },
      rank: { rrf: {} },
      nResults: cap,
      include: ["documents", "metadatas", "distances"],
    });
    return {
      mode: "hybrid",
      hits: (result?.ids ?? []).map((id, index) => ({
        id: String(id),
        score: result.distances?.[index] ?? null,
        metadata: result.metadatas?.[index] ?? {},
        document: result.documents?.[index] ?? "",
      })),
    };
  }

  const all = await target.get({
    where: { session_id: String(sessionId) },
    limit: 100_000,
    include: ["documents", "metadatas"],
  });
  const ids = all?.ids ?? [];
  const hits = [];
  for (let index = 0; index < ids.length; index += 1) {
    const metadata = all.metadatas?.[index] ?? {};
    if (metadata.session_id !== String(sessionId)) continue;
    hits.push({
      id: String(ids[index]),
      metadata,
      document: all.documents?.[index] ?? "",
    });
  }
  hits.sort((a, b) => (b.metadata.seq ?? 0) - (a.metadata.seq ?? 0));
  return { mode: "list", hits: hits.slice(0, cap) };
}

/** Number of rows in a collection. */
export async function count(name) {
  const { stateCollection, memoryCollection } = await ensureReady();
  const target = name === "memory" ? memoryCollection : stateCollection;
  if (typeof target.count === "function") return Number(await target.count());
  const all = await target.get({ limit: 100_000 });
  return (all?.ids ?? []).length;
}

/** Drop every row of both collections (used by the seed script). */
export async function reset() {
  const { stateCollection: s, memoryCollection: m } = await ensureReady();
  const removed = {};
  for (const [name, target] of [
    ["state", s],
    ["memory", m],
  ]) {
    const all = await target.get({ limit: 100_000 });
    const ids = (all?.ids ?? []).map(String);
    if (ids.length) await target.delete({ ids });
    await refreshIndex(target);
    removed[name] = ids.length;
  }
  return removed;
}

export async function close() {
  if (client && typeof client.close === "function") await client.close();
  client = null;
  stateCollection = null;
  memoryCollection = null;
}

export { config, describeTarget, embeddingsEnabled, embed };
