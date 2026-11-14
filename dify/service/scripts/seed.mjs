// Seed the session-state service's database.
//
// Usage:
//   node scripts/seed.mjs
//   node scripts/seed.mjs --reset
//
// Writes one demo session (`demo-session`) into seekdb so the database is never
// empty: it makes the read/write records inspectable straight after setup and
// gives the smoke test a known state to assert against.

import { appendMemory, close, count, describeTarget, ensureReady, reset, writeState } from "../src/seekdb.mjs";
import { defaultState } from "../src/state.mjs";

const args = new Set(process.argv.slice(2));
const SESSION_ID = process.env.DEMO_SESSION_ID ?? "demo-session";

await ensureReady();
console.log("seekdb target:", JSON.stringify(describeTarget()));

if (args.has("--reset")) {
  const removed = await reset();
  console.log("reset:", JSON.stringify(removed));
}

const base = defaultState();
const state = {
  ...base,
  turn: 1,
  location: "燭火廳",
  gold: 8,
  inventory: ["館主的名片"],
  flags: { met_keeper: false, knows_moon_gate: false, demo_seeded: true },
  last_narrative: "銅色的燭火在牆上拉出你的影子，比你本人長了半尺。",
};

await writeState(SESSION_ID, state, { last_player_input: "（種子資料）" });
await appendMemory({
  session_id: SESSION_ID,
  seq: 1,
  op: "write",
  turn: 1,
  location: state.location,
  player_input: "（種子資料）",
  summary: "種子資料建立初始狀態",
  delta: `hp ${base.hp}->${state.hp} gold ${base.gold}->${state.gold}`,
});

console.log(`seeded session ${SESSION_ID}`);
console.log("rows:", JSON.stringify({ state: await count("state"), memory: await count("memory") }));

await close();
