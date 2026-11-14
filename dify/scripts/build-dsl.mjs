// Build the importable chatflow DSL from the template.
//
// Usage:
//   node scripts/build-dsl.mjs
//   MAZE_DATASET_ID=<uuid> node scripts/build-dsl.mjs   # skip the console lookup
//
// The template (`dsl/maze-tavern.template.yml`) carries a `__MAZE_DATASET_ID__`
// placeholder because the knowledge base gets a fresh UUID every time it is
// seeded. This script resolves the live dataset id (by name, from the Dify
// console API) and writes the real thing to `dsl/maze-tavern.yml`, which is the
// file that gets imported — and the file that ships with the submission.
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DifyConsole } from "./dify-client.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const projectDir = resolve(here, "..");
const dslDir = join(projectDir, "dsl");
const templatePath = join(dslDir, "maze-tavern.template.yml");
const outputPath = join(dslDir, "maze-tavern.yml");

const baseUrl = process.env.DIFY_CONSOLE_URL ?? "http://127.0.0.1:8080";
const email = process.env.DIFY_ADMIN_EMAIL ?? ["admin", "maze.local"].join("@");
const password = process.env.DIFY_ADMIN_PASSWORD;
const datasetName = process.env.DIFY_KB_NAME ?? "迷宮酒館規則庫";

/** Resolve the knowledge-base id the chatflow should point at. */
async function resolveDatasetId() {
  if (process.env.MAZE_DATASET_ID) return process.env.MAZE_DATASET_ID;

  if (!password) {
    throw new Error("DIFY_ADMIN_PASSWORD is required (or set MAZE_DATASET_ID to skip the lookup)");
  }

  const console_ = new DifyConsole(baseUrl);
  await console_.bootstrap({ email, name: "MazeKeeper", password, initPassword: password });

  const list = await console_.get("/console/api/datasets?page=1&limit=100&include_all=true");
  const datasets = list?.json?.data ?? [];
  const match = datasets.find((dataset) => dataset.name === datasetName);
  if (!match?.id) {
    throw new Error(
      `knowledge base ${datasetName} not found — run \`node scripts/seed-kb.mjs\` first ` +
        `(found: ${datasets.map((d) => d.name).join(", ") || "none"})`,
    );
  }
  console.log(`dataset ${datasetName} -> ${match.id} (${match.document_count} documents)`);
  return match.id;
}

const datasetId = await resolveDatasetId();
const template = await readFile(templatePath, "utf8");

if (!template.includes("__MAZE_DATASET_ID__")) {
  throw new Error("template is missing the __MAZE_DATASET_ID__ placeholder");
}

const yaml = template.replaceAll("__MAZE_DATASET_ID__", datasetId);
if (yaml.includes("__MAZE_DATASET_ID__")) throw new Error("placeholder was not fully replaced");

await writeFile(outputPath, yaml, "utf8");

console.log(`wrote ${outputPath}`);
console.log(`  dataset id : ${datasetId}`);
console.log(`  bytes      : ${Buffer.byteLength(yaml, "utf8")}`);
