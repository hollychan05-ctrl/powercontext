// OpenAI-compatible embedding client.
//
// The memory log is embedded so seekdb can serve *semantic* recall of earlier
// turns (a plain full-text index cannot answer "what did I ask about the
// moon gate two turns ago?"). The endpoint is configurable, so the same code
// works against NVIDIA NIM, a local vLLM, or any other OpenAI-compatible
// /v1/embeddings server.

import { config } from "./config.mjs";

const cache = new Map();

/** True when an embedding endpoint is configured and usable. */
export function embeddingsEnabled() {
  return Boolean(config.embeddingApiKey && config.embeddingBaseUrl);
}

async function embedBatch(texts) {
  const response = await fetch(`${config.embeddingBaseUrl.replace(/\/$/, "")}/embeddings`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.embeddingApiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: config.embeddingModel,
      input: texts,
      encoding_format: "float",
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`embedding request failed: HTTP ${response.status} ${body.slice(0, 300)}`);
  }
  const json = await response.json();
  const data = json?.data ?? [];
  // The API is allowed to return items out of order — sort by `index`.
  const ordered = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const vectors = ordered.map((item) => (item.embedding ?? []).map(Number));
  if (vectors.length !== texts.length) {
    throw new Error(`embedding count mismatch: asked ${texts.length}, got ${vectors.length}`);
  }
  return vectors;
}

/**
 * Embed one or more texts.
 *
 * Identical texts reuse the cached vector — the DM state patch and the memory
 * summary often repeat the same strings, and this keeps the NIM bill and the
 * latency down.
 */
export async function embed(texts) {
  const list = Array.isArray(texts) ? texts : [texts];
  if (!embeddingsEnabled()) {
    throw new Error("EMBEDDING_API_KEY is not configured - semantic memory is disabled");
  }

  const pending = [];
  const results = new Array(list.length);
  for (let i = 0; i < list.length; i += 1) {
    const text = String(list[i] ?? "");
    const hit = cache.get(text);
    if (hit) {
      results[i] = hit;
    } else {
      pending.push({ index: i, text });
    }
  }

  for (let offset = 0; offset < pending.length; offset += config.embeddingBatch) {
    const slice = pending.slice(offset, offset + config.embeddingBatch);
    const vectors = await embedBatch(slice.map((item) => item.text));
    slice.forEach((item, i) => {
      cache.set(item.text, vectors[i]);
      results[item.index] = vectors[i];
    });
  }

  return Array.isArray(texts) ? results : results[0];
}

/** Embed a single text. */
export async function embedOne(text) {
  return (await embed([text]))[0];
}
