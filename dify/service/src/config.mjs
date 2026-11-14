// Runtime configuration for the session-state service.
//
// Every setting is environment-overridable and a tiny .env reader is built in,
// so the service can run unchanged against a local seekdb container, a WSL
// seekdb, or an OceanBase cluster.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile(resolve(projectRoot, ".env"));

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}

function str(name, fallback) {
  const raw = process.env[name];
  return raw === undefined || raw === "" ? fallback : raw;
}

const mode = str("SEEKDB_MODE", "server").toLowerCase();
if (mode !== "embedded" && mode !== "server") {
  throw new Error(`SEEKDB_MODE must be "embedded" or "server", got ${JSON.stringify(mode)}`);
}

export const config = {
  mode,
  // Embedded mode: one database directory owned by this process.
  path: str("SEEKDB_PATH", resolve(projectRoot, ".seekdb", "maze.db")),
  // Server mode: an existing seekdb / OceanBase instance.
  host: str("SEEKDB_HOST", "127.0.0.1"),
  port: int("SEEKDB_PORT", 2881),
  user: str("SEEKDB_USER", "root"),
  password: str("SEEKDB_PASSWORD", ""),
  tenant: str("SEEKDB_TENANT", ""),
  database: str("SEEKDB_DATABASE", "test"),
  stateCollection: str("STATE_COLLECTION", "maze_tavern_state"),
  memoryCollection: str("MEMORY_COLLECTION", "maze_tavern_memory"),
  embeddingBaseUrl: str("EMBEDDING_BASE_URL", "https://integrate.api.nvidia.com/v1"),
  embeddingModel: str("EMBEDDING_MODEL", "nvidia/nemotron-3-embed-1b"),
  embeddingApiKey: str("EMBEDDING_API_KEY", ""),
  embeddingDimension: int("EMBEDDING_DIMENSION", 2048),
  embeddingBatch: int("EMBEDDING_BATCH", 16),
  memoryTopK: int("MEMORY_TOP_K", 5),
  httpPort: int("PORT", 8787),
  httpHost: str("HOST", "127.0.0.1"),
  projectRoot,
};

export function describeTarget() {
  return config.mode === "embedded"
    ? { mode: "embedded", path: config.path }
    : {
        mode: "server",
        host: config.host,
        port: config.port,
        database: config.database,
        collection_prefix: config.stateCollection,
      };
}
