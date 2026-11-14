// End-to-end smoke test of the session-state service.
//
// Usage:
//   node scripts/smoke.mjs            (starts an in-process server on a free port)
//   SMOKE_BASE_URL=http://... node scripts/smoke.mjs   (test a running service)
//
// Checks, in order:
//   1. /health                     -> the service reaches seekdb
//   2. GET  /api/state             -> read a fresh session (seekdb READ + memory record)
//   3. POST /api/state             -> write a patch (seekdb WRITE + memory record)
//   4. GET  /api/state             -> the written state is really persisted
//   5. GET  /api/memory            -> the memory log has read *and* write records
//   6. GET  /api/search            -> hybrid full-text + vector recall over the log
//   7. GET  /api/world             -> the static world seed

import { randomUUID } from "node:crypto";

import { close, count, describeTarget, ensureReady } from "../src/seekdb.mjs";

let failures = 0;
function check(label, condition, detail = "") {
  const mark = condition ? "PASS" : "FAIL";
  if (!condition) failures += 1;
  console.log(`  [${mark}] ${label}${detail ? ` — ${detail}` : ""}`);
}

let baseUrl = process.env.SMOKE_BASE_URL;

if (!baseUrl) {
  await ensureReady();
  // The server module binds on import, so pick a free-ish port *before* importing.
  const port = 8799 + Math.floor(Math.random() * 100);
  process.env.PORT = String(port);
  await import("../src/server.mjs");
  baseUrl = `http://127.0.0.1:${port}`;
  await new Promise((r) => setTimeout(r, 800));
  console.log(`started service on ${baseUrl}`);
}

const sessionId = `smoke-${randomUUID().slice(0, 8)}`;

async function call(method, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json, text };
}

console.log("\n1. health");
const health = await call("GET", "/health");
check("HTTP 200", health.status === 200, `status=${health.status}`);
check("seekdb reachable", health.json?.ok === true, JSON.stringify(health.json?.db ?? {}));
check(
  "collections report rows",
  typeof health.json?.collections?.state?.rows === "number",
  JSON.stringify(health.json?.collections ?? {}),
);

console.log("\n2. read state (fresh session)");
const read = await call("GET", `/api/state?session_id=${sessionId}`);
check("HTTP 200", read.status === 200, `status=${read.status}`);
check("found=false for a new session", read.json?.found === false);
check("default location is 燭火廳", read.json?.state?.location === "燭火廳");
check("read recorded in the memory log", Number(read.json?.memory_seq) >= 1, `seq=${read.json?.memory_seq}`);

console.log("\n3. write state");
const write = await call("POST", "/api/state", {
  session_id: sessionId,
  player_input: "我要跟館主說話",
  state: {
    hp: 17,
    gold: 8,
    location: "燭火廳",
    turn: 2,
    inventory: ["館主的名片"],
    flags: { met_keeper: true },
    stats: { str: 3, agi: 4, int: 5, wil: 4 },
    last_narrative: "老霍停下了擦杯子的動作。",
  },
});
check("HTTP 200", write.status === 200, `status=${write.status}`);
check("hp persisted", write.json?.state?.hp === 17, `hp=${write.json?.state?.hp}`);
check("flag persisted", write.json?.state?.flags?.met_keeper === true);
check("delta reported", String(write.json?.delta ?? "").includes("hp 20->17"), write.json?.delta);

console.log("\n4. read state back (persistence)");
const readBack = await call("GET", `/api/state?session_id=${sessionId}`);
check("found=true now", readBack.json?.found === true);
check("hp survived the round-trip", readBack.json?.state?.hp === 17, `hp=${readBack.json?.state?.hp}`);
check("turn survived the round-trip", readBack.json?.state?.turn === 2, `turn=${readBack.json?.state?.turn}`);

console.log("\n5. memory log");
const memory = await call("GET", `/api/memory?session_id=${sessionId}&limit=50`);
const entries = memory.json?.entries ?? [];
const ops = new Set(entries.map((e) => e.metadata?.op));
check("HTTP 200", memory.status === 200);
check("memory has read records", ops.has("read"), `ops=${[...ops].join(",")}`);
check("memory has write records", ops.has("write"), `ops=${[...ops].join(",")}`);
check("at least 3 records", entries.length >= 3, `count=${entries.length}`);

console.log("\n6. hybrid memory search");
const search = await call("GET", `/api/search?session_id=${sessionId}&q=${encodeURIComponent("館主 說話")}`);
check("HTTP 200", search.status === 200, `status=${search.status}`);
check("search returns hits", (search.json?.hits?.length ?? 0) > 0, `mode=${search.json?.mode}`);
check("hybrid mode", search.json?.mode === "hybrid", `mode=${search.json?.mode}`);

console.log("\n7. world seed");
const world = await call("GET", "/api/world");
check("HTTP 200", world.status === 200);
check("rooms present", Object.keys(world.json?.rooms ?? {}).length >= 5, `rooms=${Object.keys(world.json?.rooms ?? {}).length}`);
check("npcs present", Object.keys(world.json?.npcs ?? {}).length >= 3);

console.log("\n--- seekdb row counts ---");
console.log("  state :", await count("state"));
console.log("  memory:", await count("memory"));
console.log("  target:", JSON.stringify(describeTarget()));

await close();
console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
