// Seed the 「迷宮酒館」 knowledge base into Dify (backed by seekdb).
//
// Usage:
//   node scripts/seed-kb.mjs
//
// What it does:
//   1. Creates the dataset 「迷宮酒館規則庫」 (vector store = seekdb, per the
//      deployment's VECTOR_STORE setting).
//   2. Creates a dataset-scoped API key.
//   3. Pushes every markdown file in `data/kb/` as a document through the
//      Knowledge-Base API (`POST /v1/datasets/{id}/document/create-by-text`).
//   4. Waits for the indexing batch to finish and prints the dataset id.
//
// Environment:
//   DIFY_CONSOLE_URL   default http://127.0.0.1:8080
//   DIFY_ADMIN_EMAIL   default admin@maze.local
//   DIFY_ADMIN_PASSWORD required for login
import { readdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DifyConsole } from "./dify-client.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const projectDir = resolve(here, "..");
const kbDir = join(projectDir, "data", "kb");

const baseUrl = process.env.DIFY_CONSOLE_URL ?? "http://127.0.0.1:8080";
const email = process.env.DIFY_ADMIN_EMAIL ?? ["admin", "maze.local"].join("@");
const password = process.env.DIFY_ADMIN_PASSWORD;
const datasetName = process.env.DIFY_KB_NAME ?? "迷宮酒館規則庫";
const provider = "langgenius/openai_api_compatible/openai_api_compatible";
const embeddingModel = process.env.NIM_EMBEDDING_MODEL ?? "nvidia/nemotron-3-embed-1b";

const console_ = new DifyConsole(baseUrl);
await console_.bootstrap({ email, name: "MazeKeeper", password, initPassword: password });
console.log("logged in");

// --- 1. dataset (idempotent: reuse by name) ------------------------------
const list = await console_.get("/console/api/datasets?page=1&limit=100&include_all=true");
const existing = (list?.json?.data ?? []).find((d) => d.name === datasetName);

let datasetId;
if (existing) {
  datasetId = existing.id;
  console.log(`dataset already exists: ${datasetName} (${datasetId})`);
} else {
  const created = await console_.post("/console/api/datasets", {
    name: datasetName,
    description:
      "迷宮酒館的 DM 規則卡與世界觀。向量庫由 OceanBase seekdb 承載（Dify VECTOR_STORE=seekdb）。",
    indexing_technique: "high_quality",
    permission: "only_me",
  });
  if (!created.ok) throw new Error(`create dataset failed: HTTP ${created.status} ${created.text.slice(0, 400)}`);
  datasetId = created.json?.id ?? created.json?.data?.id;
  console.log(`created dataset: ${datasetName} (${datasetId})`);
}

// Make sure the embedding model is pinned to the NVIDIA NIM one.
const patched = await console_.patch(
  `/console/api/datasets/${datasetId}`,
  {
    indexing_technique: "high_quality",
    embedding_model: embeddingModel,
    embedding_model_provider: provider,
  },
);
console.log("patch dataset ->", patched.status, patched.text.slice(0, 300));

// --- 2. dataset API key ---------------------------------------------------
const keyResponse = await console_.post("/console/api/datasets/api-keys", {
  dataset_ids: [datasetId],
});
if (!keyResponse.ok) throw new Error(`create api key failed: ${keyResponse.status} ${keyResponse.text.slice(0, 300)}`);
const apiKey = keyResponse.json?.token ?? keyResponse.json?.data?.token ?? keyResponse.json?.key;
if (!apiKey) throw new Error(`no token in api key response: ${keyResponse.text.slice(0, 400)}`);
console.log("dataset api key created");

// --- 3. push documents ----------------------------------------------------
const files = (await readdir(kbDir)).filter((f) => f.endsWith(".md")).sort();
console.log(`seeding ${files.length} documents`);

const batches = [];
for (const file of files) {
  const text = await readFile(join(kbDir, file), "utf8");
  const response = await fetch(`${baseUrl}/v1/datasets/${datasetId}/document/create-by-text`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      name: basename(file, ".md"),
      text,
      indexing_technique: "high_quality",
      doc_form: "text_model",
      doc_language: "Chinese",
      embedding_model: embeddingModel,
      embedding_model_provider: provider,
      process_rule: { mode: "automatic" },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`create-by-text ${file} failed: HTTP ${response.status} ${body.slice(0, 400)}`);
  }
  const json = JSON.parse(body);
  const batch = json?.batch ?? json?.data?.batch;
  const documentId = json?.document?.id ?? json?.data?.document?.id;
  batches.push(batch);
  console.log(`  + ${file} -> document ${documentId} batch ${batch}`);
}

// --- 4. wait for indexing -------------------------------------------------
for (const batch of batches.filter(Boolean)) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/v1/datasets/${datasetId}/documents/${batch}/indexing-status`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(60_000),
    });
    const json = await response.json();
    const data = json?.data ?? json;
    const indexing = data?.indexing_status ?? data?.status;
    const completed = data?.completed ?? 0;
    const total = data?.total ?? 0;
    if (indexing === "completed" || indexing === "error" || (total > 0 && completed >= total)) {
      console.log(`batch ${batch}: ${indexing} (${completed}/${total})`);
      if (indexing === "error") {
        console.log("  errors:", JSON.stringify(data?.errors ?? null));
      }
      break;
    }
    console.log(`batch ${batch}: ${indexing} (${completed}/${total})`);
    await new Promise((r) => setTimeout(r, 3000));
  }
}

// --- 5. summary -----------------------------------------------------------
const docs = await console_.get(`/console/api/datasets/${datasetId}/documents?page=1&limit=100`);
const docList = docs?.json?.data ?? [];
console.log("\n--- dataset summary ---");
console.log("dataset_id :", datasetId);
console.log("documents  :", docList.length);
for (const doc of docList) {
  console.log(`  - ${doc.name}: ${doc.indexing_status} (${doc.segment_count ?? 0} segments)`);
}

console.log("\nAdd the dataset id to your chatflow's Knowledge Retrieval node.");
console.log(JSON.stringify({ datasetId, documents: docList.length }));
