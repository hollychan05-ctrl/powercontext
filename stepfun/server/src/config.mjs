// Runtime configuration for the local backend.
//
// All settings are environment-overridable so the same source runs against an
// embedded seekdb (default, `path`) or a seekdb/OceanBase server (`host`/`port`).
// A tiny .env reader avoids pulling a dotenv dependency.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..", "..");

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

const mode = (process.env.SEEKDB_MODE ?? "embedded").toLowerCase();
if (mode !== "embedded" && mode !== "server") {
  throw new Error(`SEEKDB_MODE must be "embedded" or "server", got ${JSON.stringify(mode)}`);
}

export const config = {
  mode,
  // Embedded mode: one database directory owned by this process.
  path: process.env.SEEKDB_PATH ?? resolve(projectRoot, ".seekdb", "kb.db"),
  // Server mode: an existing seekdb / OceanBase instance (e.g. 127.0.0.1:2882).
  host: process.env.SEEKDB_HOST ?? "127.0.0.1",
  port: int("SEEKDB_PORT", 2882),
  user: process.env.SEEKDB_USER ?? "root",
  password: process.env.SEEKDB_PASSWORD ?? "",
  tenant: process.env.SEEKDB_TENANT ?? "",
  database: process.env.SEEKDB_DATABASE ?? "test",
  collection: process.env.SEEKDB_COLLECTION ?? "kb_documents",
  httpPort: int("PORT", 8787),
  // The embedding model runs in the browser; the backend only stores vectors, so the
  // dimension must match the selected model (all-MiniLM-L6-v2 / bge-small-en-v1.5 = 384).
  dimension: int("EMBEDDING_DIMENSION", 384),
  projectRoot,
};

export function describeTarget() {
  return config.mode === "embedded"
    ? { mode: "embedded", path: config.path }
    : { mode: "server", host: config.host, port: config.port, database: config.database };
}
