// Validate the exported chatflow DSL without printing any identifiers.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const file = resolve(process.argv[2] ?? "dsl/maze-tavern.yml");
const s = await readFile(file, "utf8");

const checks = {
  "is a yaml mapping": /^app:\n/m.test(s),
  "kind: app": /^kind:\s*app$/m.test(s),
  "version 0.7.0": /^version:\s*0\.7\.0$/m.test(s),
  "mode advanced-chat": /mode:\s*advanced-chat/.test(s),
  "dataset id is a plain uuid": /dataset_ids:\n\s*- [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(s),
  "no encrypted dataset id": !/dataset_ids:\n\s*- [A-Za-z0-9+/=]{40,}/.test(s),
  "env var MAZE_SERVICE_URL": s.includes("MAZE_SERVICE_URL"),
  "env selector used": s.includes("{{#env.MAZE_SERVICE_URL#}}"),
  "state fence in prompt": s.includes("```state"),
  "code node main()": s.includes("def main(dm_text"),
  "code node parser": s.includes("_split_state"),
  "http get node": /method:\s*get/.test(s),
  "http post node": /method:\s*post/.test(s),
  "form-urlencoded body": s.includes("x-www-form-urlencoded"),
  "knowledge retrieval node": s.includes("type: knowledge-retrieval"),
  "llm node": s.includes("type: llm"),
  "answer node": s.includes("type: answer"),
  "context endpoint used": s.includes("/api/context"),
  "state endpoint used": s.includes("/api/state"),
  "briefing injected into prompt": s.includes("{{#get_context.body#}}"),
  "no dify conversation memory (seekdb is the memory layer)": !/\n\s+memory:\s*\n/.test(s),
  "context selector": s.includes("{{#context#}}"),
  "panel copy is forbidden in the prompt": s.includes("狀態面板"),
  "no placeholder left": !s.includes("__MAZE_DATASET_ID__") && !s.includes("__PG_"),
};

let failed = 0;
for (const [label, ok] of Object.entries(checks)) {
  if (!ok) failed += 1;
  console.log(`${ok ? "[PASS]" : "[FAIL]"} ${label}`);
}

// node inventory
const ids = [...s.matchAll(/^\s{6}id: ([\w-]+)$/gm)].map((m) => m[1]);
console.log(`\nnode ids : ${ids.join(", ") || "(none)"}`);
console.log(`bytes    : ${Buffer.byteLength(s, "utf8")}`);
console.log(failed === 0 ? "\nALL CHECKS PASSED" : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
