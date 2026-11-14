// Install Dify's model plugins and configure NVIDIA NIM models.
//
// Usage:
//   node scripts/setup-model.mjs
//   node scripts/setup-model.mjs --install-only
//
// Environment:
//   DIFY_CONSOLE_URL   default http://127.0.0.1:8080
//   DIFY_ADMIN_EMAIL   default admin@maze.local
//   DIFY_ADMIN_PASSWORD required for login
//   NVIDIA_API_KEY     required to configure the NVIDIA NIM provider
//   NIM_BASE_URL       default https://integrate.api.nvidia.com/v1
import { DifyConsole } from "./dify-client.mjs";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
}

const baseUrl = args.get("base") ?? process.env.DIFY_CONSOLE_URL ?? "http://127.0.0.1:8080";
const email = args.get("email") ?? process.env.DIFY_ADMIN_EMAIL ?? ["admin", "maze.local"].join("@");
const password = args.get("password") ?? process.env.DIFY_ADMIN_PASSWORD;
const initPassword = args.get("init-password") ?? process.env.DIFY_INIT_PASSWORD ?? password;

/** Plugins to install: `org/name` plus the version we want to pin. */
const PLUGINS = [
  { id: "langgenius/openai_api_compatible", version: "0.0.83" },
  { id: "langgenius/openai", version: "1.1.0" },
];

const PROVIDER = "langgenius/openai_api_compatible/openai_api_compatible";
const MARKETPLACE = process.env.DIFY_MARKETPLACE_URL ?? "https://marketplace.dify.ai";

/** NVIDIA NIM models we wire up. */
const LLM_MODEL = process.env.NIM_LLM_MODEL ?? "nvidia/nemotron-3-ultra-550b-a55b";
const EMBEDDING_MODEL = process.env.NIM_EMBEDDING_MODEL ?? "nvidia/nemotron-3-embed-1b";

/**
 * Resolve `org/name:version` to the marketplace's *package* identifier.
 *
 * The install endpoint needs the full `org/name:version@sha256` form — the
 * short `org/name:version` is rejected with
 * `{"code":-1,"msg":"plugin unique identifier is invalid"}`.
 */
async function resolvePackageIdentifier({ id, version }) {
  const detail = await fetch(`${MARKETPLACE}/api/v1/plugins/${id}`, {
    headers: { "user-agent": "opencode-dify-setup", accept: "application/json" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!detail.ok) throw new Error(`marketplace ${id} -> HTTP ${detail.status}`);
  const plugin = (await detail.json())?.data?.plugin ?? {};

  if (version && plugin.latest_version !== version) {
    const versionsResponse = await fetch(`${MARKETPLACE}/api/v1/plugins/${id}/versions`, {
      headers: { "user-agent": "opencode-dify-setup", accept: "application/json" },
      signal: AbortSignal.timeout(60_000),
    });
    const versions = (await versionsResponse.json())?.data?.versions ?? [];
    const match = versions.find((v) => v.version === version);
    if (match?.package_identifier) return match.package_identifier;
    if (plugin.latest_package_identifier?.includes(`:${version}@`)) return plugin.latest_package_identifier;
  }
  if (!plugin.latest_package_identifier) throw new Error(`no package identifier for ${id}`);
  return plugin.latest_package_identifier;
}

/** The console wraps payloads in `{data: ...}`; unwrap whatever shape arrives. */
function normalizeList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.data?.plugins)) return payload.data.plugins;
  return [];
}

const console_ = new DifyConsole(baseUrl);
await console_.bootstrap({ email, name: "MazeKeeper", password, initPassword });
console.log("logged in");

// --- 1. install plugins --------------------------------------------------
const installed = await console_.get("/console/api/workspaces/current/plugin/installed-ids?category=model");
const installedIds = normalizeList(installed?.json);
console.log("installed model plugins:", JSON.stringify(installedIds));

const missing = PLUGINS.filter((plugin) => {
  return !installedIds.some((entry) => String(entry.plugin_id ?? entry).startsWith(plugin.id));
});
if (missing.length === 0) {
  console.log("nothing to install");
} else {
  const identifiers = [];
  for (const plugin of missing) {
    const identifier = await resolvePackageIdentifier(plugin);
    console.log(`resolved ${plugin.id}@${plugin.version} -> ${identifier}`);
    identifiers.push(identifier);
  }
  console.log("installing:", identifiers.join(", "));
  const result = await console_.post("/console/api/workspaces/current/plugin/install/marketplace", {
    plugin_unique_identifiers: identifiers,
  });
  console.log("install response:", result.status, result.text.slice(0, 400));
}

// Install runs asynchronously; poll the task list until it settles.
const deadline = Date.now() + 240_000;
let lastState = "";
while (Date.now() < deadline) {
  const tasks = await console_.get("/console/api/workspaces/current/plugin/tasks?page=1&page_size=20");
  const list = normalizeList(tasks?.json);
  const state = JSON.stringify(list.map((t) => [t.plugin_unique_identifier ?? t.id, t.status ?? t.state]));
  if (state !== lastState) {
    console.log("tasks:", state);
    lastState = state;
  }
  const pending = list.some((t) => !["success", "failed", "error"].includes(String(t.status ?? t.state).toLowerCase()));
  if (!pending && list.length > 0) break;
  await new Promise((r) => setTimeout(r, 3000));
}

const after = await console_.get("/console/api/workspaces/current/plugin/installed-ids?category=model");
console.log("installed model plugins now:", JSON.stringify(normalizeList(after?.json)));

if (args.get("install-only")) process.exit(0);

// --- 2. configure provider credentials ----------------------------------
const apiKey = process.env.NVIDIA_API_KEY;
const endpoint = process.env.NIM_BASE_URL ?? "https://integrate.api.nvidia.com/v1";
if (!apiKey) {
  console.log("NVIDIA_API_KEY not set - skipping credential configuration");
  process.exit(0);
}

/**
 * Create (or reuse) a custom-model credential and make it the active one.
 *
 * `customizable-model` providers need two calls:
 *   POST .../models/credentials  -> create the credential row
 *   POST .../models              -> switch the active credential for that model
 */
async function configureCustomModel({ model, modelType, name, credentials }) {
  const listUrl = `/console/api/workspaces/current/model-providers/${PROVIDER}/models`;
  const credUrl = `/console/api/workspaces/current/model-providers/${PROVIDER}/models/credentials`;

  // Already configured? Reuse the active credential.
  const existing = await console_.get(
    `${credUrl}?model=${encodeURIComponent(model)}&model_type=${modelType}`,
  );
  const currentId = existing?.json?.current_credential_id;
  if (currentId) {
    console.log(`${modelType} ${model}: already configured (credential ${currentId})`);
  } else {
    const created = await console_.post(credUrl, {
      model,
      model_type: modelType,
      name,
      credentials,
    });
    console.log(`${modelType} ${model}: create credential ->`, created.status, created.text.slice(0, 300));
    if (created.status >= 300) {
      throw new Error(`failed to create credential for ${model}: ${created.text}`);
    }
  }

  // Make sure the model is registered and points at the active credential.
  const refreshed = await console_.get(
    `${credUrl}?model=${encodeURIComponent(model)}&model_type=${modelType}`,
  );
  const credentialId = refreshed?.json?.current_credential_id;
  if (!credentialId) throw new Error(`no credential id for ${model}`);

  const activated = await console_.post(listUrl, {
    model,
    model_type: modelType,
    config_from: "custom-model",
    credential_id: credentialId,
  });
  console.log(`${modelType} ${model}: activate ->`, activated.status, activated.text.slice(0, 200));
  return credentialId;
}

await configureCustomModel({
  model: LLM_MODEL,
  modelType: "llm",
  name: "NVIDIA NIM LLM",
  credentials: {
    endpoint_url: endpoint,
    api_key: apiKey,
    mode: "chat",
    context_size: "32768",
    max_tokens_to_sample: "4096",
    agent_thought_support: "not_supported",
    vision_support: "no_support",
    video_support: "no_support",
    audio_support: "no_support",
    document_support: "no_support",
    web_search_support: "not_supported",
    compatibility_mode: "strict",
    api_type: "chat_completions",
    token_param_name: "max_tokens",
    user_identity_support: "no_support",
    stream_include_usage: "enabled",
    function_calling_type: "no_call",
    stream_function_calling: "not_supported",
    structured_output_support: "not_supported",
    stream_mode_auth: "not_use",
  },
});

await configureCustomModel({
  model: EMBEDDING_MODEL,
  modelType: "text-embedding",
  name: "NVIDIA NIM Embedding",
  credentials: {
    endpoint_url: endpoint,
    api_key: apiKey,
    max_chunks: "16",
    context_size: "32768",
    encoding_format: "not_set",
    vision_support: "no_support",
    document_prefix: "",
    query_prefix: "",
  },
});

// --- 3. set workspace defaults ------------------------------------------
const defaults = await console_.post("/console/api/workspaces/current/default-model", {
  model_settings: [
    { model_type: "llm", provider: PROVIDER, model: LLM_MODEL },
    { model_type: "text-embedding", provider: PROVIDER, model: EMBEDDING_MODEL },
  ],
});
console.log("set defaults ->", defaults.status, defaults.text.slice(0, 300));

const finalModels = await console_.get(`/console/api/workspaces/current/model-providers/${PROVIDER}/models`);
console.log(
  "provider models:",
  JSON.stringify(
    (finalModels?.json?.data ?? []).map((m) => ({
      model: m.model,
      type: m.model_type,
      provider: m.provider,
    })),
  ),
);
