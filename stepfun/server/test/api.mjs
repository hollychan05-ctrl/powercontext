// End-to-end HTTP API test: boots the real backend, drives it over HTTP exactly like
// the browser does, and checks the static hosting of the web app.
//
//   node server/test/api.mjs
//
// Requires a reachable seekdb (SEEKDB_MODE=server) or an embedded one whose native
// addon can be loaded. The child process is always stopped, even on failure.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { config } from "../src/config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(here, "..", "src", "index.mjs");
const webRoot = resolve(here, "..", "..", "web");

const PORT = process.env.API_TEST_PORT ?? String(8799);
const BASE = `http://127.0.0.1:${PORT}`;

function oneHot(index, dimension) {
  const vector = new Array(dimension).fill(0);
  vector[index] = 1;
  return vector;
}

async function waitForHealth(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return await response.json();
    } catch {
      // server not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`backend did not become healthy within ${timeoutMs}ms`);
}

async function post(path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${path} -> ${response.status}: ${text}`);
  return parsed;
}

async function main() {
  console.log(`seekdb mode=${config.mode} collection=${config.collection} dim=${config.dimension}`);
  console.log(`booting backend on port ${PORT} ...`);

  const child = spawn(process.execPath, [serverEntry], {
    env: { ...process.env, PORT },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => process.stdout.write(`[server] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[server] ${chunk}`));

  try {
    const health = await waitForHealth();
    assert.equal(health.ok, true);
    assert.equal(health.dimension, config.dimension);
    console.log("health:", JSON.stringify(health));

    // Clean slate through the public API.
    await post("/api/reset");

    // Ingest exactly like the browser: text + browser-computed vector.
    const docs = [
      { id: "alpha", text: "alpha apple fruit", embedding: oneHot(0, config.dimension), metadata: { topic: "fruit" } },
      { id: "beta", text: "beta banana fruit", embedding: oneHot(1, config.dimension), metadata: { topic: "fruit" } },
      { id: "gamma", text: "gamma grape fruit", embedding: oneHot(2, config.dimension), metadata: { topic: "fruit" } },
    ];
    const ingested = await post("/api/ingest", { items: docs });
    assert.equal(ingested.upserted, 3);
    console.log("ingest:", JSON.stringify(ingested));

    const stats = await fetch(`${BASE}/api/stats`).then((r) => r.json());
    assert.equal(stats.count, 3);
    console.log("stats.count:", stats.count);

    // Hybrid search: keyword channel + vector channel fused by seekdb.
    const hybrid = await post("/api/search", {
      query: "banana",
      embedding: oneHot(0, config.dimension),
      nResults: 3,
      mode: "hybrid",
    });
    const ids = hybrid.hits.map((hit) => hit.id);
    console.log("hybrid order:", ids.join(", "));
    assert.equal(hybrid.mode, "hybrid");
    assert.ok(ids.includes("beta"), "keyword match beta must be returned");
    assert.ok(ids.includes("alpha"), "vector match alpha must be returned");

    // A just-written document must be retrievable (index refresh).
    const probe = await post("/api/verify", { id: "gamma", embedding: oneHot(2, config.dimension) });
    assert.equal(probe.rank, 1);
    console.log("verify gamma rank:", probe.rank);

    // Vector-only mode.
    const vectorOnly = await post("/api/search", {
      query: "",
      embedding: oneHot(0, config.dimension),
      nResults: 3,
      mode: "vector",
    });
    assert.equal(vectorOnly.hits[0].id, "alpha");
    console.log("vector top:", vectorOnly.hits[0].id);

    // Dimension mismatch must be rejected with a clear message.
    await assert.rejects(
      () => post("/api/ingest", { items: [{ id: "bad", text: "x", embedding: [1, 2, 3] }] }),
      /must be an array of 384/,
    );
    console.log("dimension guard: ok");

    // Static hosting of the browser app.
    const page = await fetch(`${BASE}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    const html = await page.text();
    assert.match(html, /端侧知识库/);
    const bundle = await fetch(`${BASE}/src/main.js`);
    assert.equal(bundle.status, 200);
    assert.match(bundle.headers.get("content-type") ?? "", /javascript/);
    console.log("static hosting: index.html + src/main.js served");

    await post("/api/reset");
    console.log("\napi OK");
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 400));
    if (!child.killed) child.kill("SIGKILL");
  }
}

main().catch((error) => {
  console.error("api FAILED:", error);
  process.exitCode = 1;
});
