// Backend smoke test: exercises write / hybrid search / vector search / verify / stats
// against a real seekdb using deterministic synthetic vectors (no browser needed).
//
//   npm --prefix server install
//   node server/test/smoke.mjs

import assert from "node:assert/strict";

import { close, ensureReady, ingest, reset, search, stats, verify } from "../src/seekdb.mjs";
import { config } from "../src/config.mjs";

function oneHot(index) {
  const vector = new Array(config.dimension).fill(0);
  vector[index] = 1;
  return vector;
}

async function main() {
  console.log(`seekdb mode=${config.mode} collection=${config.collection} dim=${config.dimension}`);
  await ensureReady();
  await reset();

  const docs = [
    { id: "alpha", text: "alpha apple fruit", embedding: oneHot(0), metadata: { topic: "fruit" } },
    { id: "beta", text: "beta banana fruit", embedding: oneHot(1), metadata: { topic: "fruit" } },
    { id: "gamma", text: "gamma grape fruit", embedding: oneHot(2), metadata: { topic: "fruit" } },
  ];
  const { upserted } = await ingest(docs);
  assert.equal(upserted, 3);

  const report = await stats();
  console.log("count after ingest:", report.count);
  assert.ok(report.count >= 3);

  // Pure vector search must rank the identical vector first.
  const vectorOnly = await search({ query: "", embedding: oneHot(0), nResults: 3, mode: "vector" });
  assert.equal(vectorOnly.hits[0].id, "alpha", "vector search should rank alpha first");
  console.log("vector top:", vectorOnly.hits.map((hit) => hit.id).join(", "));

  // Hybrid search must fuse the keyword channel ("banana" -> beta) with the vector channel.
  const hybrid = await search({ query: "banana", embedding: oneHot(0), nResults: 3, mode: "hybrid" });
  const ids = hybrid.hits.map((hit) => hit.id);
  console.log("hybrid order:", ids.join(", "));
  assert.ok(ids.includes("alpha"), "hybrid should include the vector match");
  assert.ok(ids.includes("beta"), "hybrid should include the keyword match");

  // Freshly written rows must be retrievable after the write.
  const check = await verify("gamma", oneHot(2));
  assert.equal(check.rank, 1, "gamma should be retrievable immediately after write");
  console.log("verify gamma rank:", check.rank);

  await reset();
  const cleared = await stats();
  assert.equal(cleared.count, 0);
  console.log("smoke OK");
}

main()
  .catch((error) => {
    console.error("smoke FAILED:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await close().catch(() => {});
  });
