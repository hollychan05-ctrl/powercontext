// Pure-logic unit tests. No seekdb import, no native addon, no network.
//
//   node server/test/unit.mjs
//
// Covers the two pieces of non-trivial logic in this project: seekdb result
// normalization (rows/toHits/validateVectors) and the retrieval metrics shared
// with the browser (web/src/metrics.js).

import assert from "node:assert/strict";

import { rows, toHits, validateVectors } from "../src/rows.mjs";
import { ndcgAtK, rankedIds, recallAtK } from "../../web/src/metrics.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

console.log("rows()");
test("null/undefined -> []", () => {
  assert.deepEqual(rows(null), []);
  assert.deepEqual(rows(undefined), []);
});
test("flat array (get) passes through", () => {
  assert.deepEqual(rows(["a", "b"]), ["a", "b"]);
});
test("nested array (query/hybridSearch) flattens the first query", () => {
  assert.deepEqual(rows([["a", "b"]]), ["a", "b"]);
});
test("scalar wraps into a one-element array", () => {
  assert.deepEqual(rows("a"), ["a"]);
});

console.log("toHits()");
test("nested SDK shape maps to indexed hits", () => {
  const hits = toHits({
    ids: [["d1", "d2"]],
    documents: [["first", "second"]],
    metadatas: [[{ topic: "a" }, { topic: "b" }]],
    distances: [[0.1, 0.25]],
  });
  assert.equal(hits.length, 2);
  assert.deepEqual(hits[0], {
    id: "d1",
    document: "first",
    metadata: { topic: "a" },
    distance: 0.1,
  });
  assert.equal(hits[1].id, "d2");
  assert.equal(hits[1].distance, 0.25);
});
test("flat SDK shape also maps correctly", () => {
  const hits = toHits({ ids: ["x"], documents: ["only"], metadatas: [null], distances: [0.5] });
  assert.deepEqual(hits, [{ id: "x", document: "only", metadata: null, distance: 0.5 }]);
});
test("missing optional fields degrade to null", () => {
  const hits = toHits({ ids: [["a", "b"]] });
  assert.deepEqual(hits, [
    { id: "a", document: null, metadata: null, distance: null },
    { id: "b", document: null, metadata: null, distance: null },
  ]);
});
test("stringified ids and numeric distances are coerced", () => {
  const hits = toHits({ ids: [[42]], distances: [["0.7"]] });
  assert.equal(hits[0].id, "42");
  assert.equal(hits[0].distance, 0.7);
});
test("empty result -> []", () => {
  assert.deepEqual(toHits(undefined), []);
  assert.deepEqual(toHits({ ids: [] }), []);
});

console.log("validateVectors()");
test("accepts vectors of the expected dimension", () => {
  validateVectors([{ id: "a", embedding: [0, 1, 2] }], 3);
});
test("rejects a wrong-length vector", () => {
  assert.throws(() => validateVectors([{ id: "bad", embedding: [0, 1] }], 3), /must be an array of 3/);
});
test("rejects a non-array embedding", () => {
  assert.throws(() => validateVectors([{ id: "bad", embedding: "nope" }], 3), /must be an array of 3/);
});

console.log("recallAtK() / ndcgAtK()");
const relevant = new Set(["a", "b"]);
test("Recall@K counts relevant ids in the top K", () => {
  assert.equal(recallAtK(["a", "x", "b", "y"], relevant, 3), 1); // both "a" and "b" in top 3
  assert.equal(recallAtK(["a", "x", "b", "y"], relevant, 2), 0.5); // only "a" within first 2
  assert.equal(recallAtK(["a", "b", "x"], relevant, 3), 1);
  assert.equal(recallAtK(["x", "y", "z"], relevant, 3), 0);
});
test("perfect ranking gives nDCG@K = 1", () => {
  assert.equal(ndcgAtK(["a", "b", "x"], relevant, 3), 1);
});
test("nDCG@K penalizes relevant items ranked lower", () => {
  const perfect = ndcgAtK(["a", "b"], relevant, 2);
  const shifted = ndcgAtK(["x", "a", "b"], relevant, 3);
  assert.ok(shifted < perfect && shifted > 0, `expected 0 < ${shifted} < ${perfect}`);
});
test("empty relevant set -> null (query excluded from averages)", () => {
  assert.equal(recallAtK(["a"], new Set(), 5), null);
  assert.equal(ndcgAtK(["a"], new Set(), 5), null);
});

console.log("rankedIds()");
test("handles plain ids and {id} hit objects", () => {
  assert.deepEqual(rankedIds(["a", "b"]), ["a", "b"]);
  assert.deepEqual(rankedIds([{ id: "h1" }, { id: 7 }]), ["h1", "7"]);
  assert.deepEqual(rankedIds(undefined), []);
});

console.log(`\nunit OK (${passed} assertions)`);
