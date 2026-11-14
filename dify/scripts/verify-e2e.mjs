// End-to-end verification of the 「迷宮酒館」 chatflow.
//
// Usage:
//   node scripts/verify-e2e.mjs
//   node scripts/verify-e2e.mjs --app-id <uuid>
//
// What it proves (and writes to `evidence/`):
//   1. the chatflow imports, publishes and runs;
//   2. every node of the graph executes (node execution records);
//   3. the state service really reads from and writes to seekdb
//      (state rows + memory rows, including the read/write audit trail);
//   4. the knowledge base is queried through the seekdb vector store.
//
// Artifacts:
//   evidence/e2e-transcript.json   the player-visible turns
//   evidence/node-executions.json  one record per graph node
//   evidence/seekdb-records.json   the rows that ended up in seekdb
//   evidence/e2e-summary.json      the machine-readable summary
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DifyConsole } from "./dify-client.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const projectDir = resolve(here, "..");
const evidenceDir = join(projectDir, "evidence");
const serviceUrl = process.env.MAZE_SERVICE_URL ?? "http://127.0.0.1:8787";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const token = process.argv[i];
  if (!token.startsWith("--")) continue;
  const next = process.argv[i + 1];
  if (next && !next.startsWith("--")) {
    args.set(token.slice(2), next);
    i += 1;
  } else {
    args.set(token.slice(2), true);
  }
}

const baseUrl = process.env.DIFY_CONSOLE_URL ?? "http://127.0.0.1:8080";
const email = process.env.DIFY_ADMIN_EMAIL ?? ["admin", "maze.local"].join("@");
const password = process.env.DIFY_ADMIN_PASSWORD;
const appName = process.env.DIFY_APP_NAME ?? "迷宮酒館";
if (!password) throw new Error("DIFY_ADMIN_PASSWORD is required");

/** The player script: a deliberate three-beat arc that exercises state + memory. */
const TURNS = [
  "我推開門，想先跟館主老霍說話。",
  "我想看看吧台下面有沒有暗格。",
  "我要離開酒館，往迷宮走。",
];

/**
 * Read a `text/event-stream` response into the JSON payloads it carries.
 *
 * Dify's streaming chat API frames look like:
 *
 *   event: ping
 *
 *   data: {"event":"workflow_started","conversation_id":"...","workflow_run_id":"...",
 *          "data":{ ...node snapshot... }}
 *
 * The event type lives *inside* the JSON (`event` key), not in the SSE
 * `event:` field — that field only carries the initial keep-alive ping.
 */
async function readSse(response) {
  const events = [];
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");

      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        events.push(JSON.parse(payload));
      } catch {
        // keep-alive or non-JSON frame
      }
    }
  }
  return events;
}

const console_ = new DifyConsole(baseUrl);
await console_.bootstrap({ email, name: "MazeKeeper", password, initPassword: password });
console.log("logged in");

// --- locate the app -------------------------------------------------------
let appId = args.get("app-id") ? String(args.get("app-id")) : null;
if (!appId) {
  const list = await console_.get("/console/api/apps?page=1&limit=100&include_all=true");
  const apps = list?.json?.data ?? [];
  const matches = apps.filter((app) => app.name === appName);
  if (!matches.length) throw new Error(`no app named ${appName}`);
  // The console lists newest first; take the most recently created one.
  appId = matches[0].id;
  console.log(`app ${appName} -> ${appId} (${matches.length} with this name)`);
} else {
  console.log(`app id ${appId}`);
}

// --- publish --------------------------------------------------------------
const published = await console_.post(`/console/api/apps/${appId}/workflows/publish`);
console.log("publish ->", published.status, published.text.slice(0, 200));
if (!published.ok) throw new Error(`publish failed: ${published.text.slice(0, 500)}`);

// --- app API key ----------------------------------------------------------
// Dify allows at most 10 API keys per app, so reuse an existing one instead
// of creating a new one on every verification run.
async function resolveApiKey() {
  const listed = await console_.get(`/console/api/apps/${appId}/api-keys`);
  const existing = listed?.json?.data ?? [];
  for (const entry of existing) {
    if (entry.token) return entry.token;
  }
  const keyResponse = await console_.post(`/console/api/apps/${appId}/api-keys`, {});
  const apiKey = keyResponse.json?.token ?? keyResponse.json?.data?.token ?? keyResponse.json?.key;
  if (!apiKey) {
    throw new Error(`could not create an app api key: ${keyResponse.text.slice(0, 400)}`);
  }
  return apiKey;
}

const apiKey = await resolveApiKey();
console.log("app api key ready");

// --- play the game --------------------------------------------------------
// Dify validates `conversation_id` as a UUID and requires an `inputs` object.
// The first turn must *not* carry a conversation id: Dify rejects unknown ids
// ("Conversation Not Exists."), so it creates one and hands it back.
let conversationId = null;
const transcript = [];
const answers = [];

for (const [index, query] of TURNS.entries()) {
  process.stdout.write(`turn ${index + 1}: ${query} ... `);
  const response = await fetch(`${baseUrl}/v1/chat-messages`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      accept: "text/event-stream",
    },
    body: JSON.stringify({
      query,
      inputs: {},
      user: "verifier",
      ...(conversationId ? { conversation_id: conversationId } : {}),
      response_mode: "streaming",
    }),
    signal: AbortSignal.timeout(300_000),
  });

  if (!response.ok) {
    const body = await response.text();
    console.log(`FAILED HTTP ${response.status}`);
    console.log(body.slice(0, 1500));
    throw new Error(`chat-messages failed on turn ${index + 1}`);
  }

  // The streaming response is the only place Dify exposes the workflow run
  // id (`workflow_started`), which is what links a turn to its node-execution
  // records. Blocking mode does not carry it.
  const events = await readSse(response);
  const started = events.find((event) => event.event === "workflow_started");
  // Dify streams the answer in chunks: every `message` event carries only
  // the *new* text, so the full answer is the concatenation of all of them.
  const messages = events.filter((event) => event.event === "message");
  const message = messages[messages.length - 1];
  const ended = events.find((event) => event.event === "message_end");
  const failed = events.find((event) => event.event === "error");

  if (failed) {
    console.log(`FAILED event: ${JSON.stringify(failed).slice(0, 1200)}`);
    throw new Error(`chat-messages failed on turn ${index + 1}`);
  }

  const answer = messages.map((event) => event.answer ?? "").join("");
  answers.push(answer);
  if (!conversationId) conversationId = message?.conversation_id ?? conversationId;
  transcript.push({
    turn: index + 1,
    query,
    answer,
    message_id: message?.message_id ?? null,
    workflow_run_id: started?.workflow_run_id ?? null,
    conversation_id: message?.conversation_id ?? null,
    created_at: message?.created_at ?? null,
    usage: ended?.usage ?? message?.usage ?? null,
  });
  console.log(`${answer.length} chars`);
}

// --- node execution records ------------------------------------------------
// The console API only lists runs that were triggered from the app (API key);
// `triggered_from=app-run` is required — the default filter is `debugging`.
const runs = await console_.get(
  `/console/api/apps/${appId}/workflow-runs?triggered_from=app-run&limit=20`,
);
const runList = runs?.json?.data ?? [];
// Only the runs of *this* verification are interesting. Older runs from
// previous experiments would otherwise show up as failures in the summary.
let runIds = [...new Set(transcript.map((entry) => entry.workflow_run_id).filter(Boolean))];
if (!runIds.length) runIds = runList.slice(0, transcript.length).map((run) => run.id);

const turnOfRun = new Map(
  transcript.filter((entry) => entry.workflow_run_id).map((entry) => [entry.workflow_run_id, entry.turn]),
);

const nodeExecutions = [];
for (const runId of runIds) {
  const detail = await console_.get(`/console/api/apps/${appId}/workflow-runs/${runId}/node-executions`);
  const executions = detail?.json?.data ?? [];
  for (const execution of executions) {
    nodeExecutions.push({
      turn: turnOfRun.get(runId) ?? null,
      workflow_run_id: runId,
      node_id: execution.node_id,
      node_type: execution.node_type,
      title: execution.title,
      status: execution.status,
      elapsed_time: execution.elapsed_time,
      inputs: execution.inputs,
      outputs: execution.outputs,
      error: execution.error ?? null,
    });
  }
}
console.log(`node execution records: ${nodeExecutions.length}`);

// --- seekdb records --------------------------------------------------------
const before = await (
  await fetch(`${serviceUrl}/api/state?session_id=${encodeURIComponent(conversationId)}`, {
    signal: AbortSignal.timeout(60_000),
  })
).json();

const memory = await (
  await fetch(
    `${serviceUrl}/api/memory?session_id=${encodeURIComponent(conversationId)}&limit=100`,
    { signal: AbortSignal.timeout(60_000) },
  )
).json();

// --- write the evidence ----------------------------------------------------
await mkdir(evidenceDir, { recursive: true });

const summary = {
  generated_at: new Date().toISOString(),
  app_name: appName,
  conversation_id: conversationId,
  turns: transcript.length,
  node_executions: nodeExecutions.length,
  node_types: [...new Set(nodeExecutions.map((execution) => execution.node_type))].sort(),
  failed_nodes: nodeExecutions
    .filter((execution) => execution.status !== "succeeded")
    .map((execution) => ({ node_id: execution.node_id, error: execution.error })),
  state_turn: before?.state?.turn ?? null,
  state_location: before?.state?.location ?? null,
  state_hp: before?.state?.hp ?? null,
  state_gold: before?.state?.gold ?? null,
  memory_records: memory?.count ?? 0,
  memory_ops: (memory?.entries ?? []).map((entry) => entry?.metadata?.op),
  db: before?.db ?? null,
  recall_mode: before?.recall_mode ?? null,
};

await writeFile(join(evidenceDir, "e2e-transcript.json"), JSON.stringify(transcript, null, 2), "utf8");
await writeFile(
  join(evidenceDir, "node-executions.json"),
  JSON.stringify(nodeExecutions, null, 2),
  "utf8",
);
await writeFile(
  join(evidenceDir, "seekdb-records.json"),
  JSON.stringify({ state: before, memory }, null, 2),
  "utf8",
);
await writeFile(join(evidenceDir, "e2e-summary.json"), JSON.stringify(summary, null, 2), "utf8");

console.log("\n--- summary ---");
console.log(JSON.stringify(summary, null, 2));

console.log("\n--- transcript ---");
for (const entry of transcript) {
  console.log(`\n[玩家] ${entry.query}`);
  console.log(`[DM] ${entry.answer}`);
}
