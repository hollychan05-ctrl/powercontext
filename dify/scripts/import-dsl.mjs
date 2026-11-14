// Import the 「迷宮酒館」 chatflow DSL into Dify and export it back.
//
// Usage:
//   node scripts/import-dsl.mjs
//   node scripts/import-dsl.mjs --file dsl/maze-tavern.yml
//   node scripts/import-dsl.mjs --app-id <existing-app-id>   # overwrite
//
// Why export again after importing?
// Dify rewrites the DSL on import (it encrypts dataset ids when
// `DSL_EXPORT_ENCRYPT_DATASET_ID` is on, fills in node defaults, and rewrites
// the `dependencies` block). Re-exporting guarantees that the file we ship is
// byte-for-byte what this Dify version produces — i.e. it is importable.
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DifyConsole } from "./dify-client.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const projectDir = resolve(here, "..");
const dslDir = join(projectDir, "dsl");

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
const dslPath = args.get("file")
  ? resolve(projectDir, String(args.get("file")))
  : join(dslDir, "maze-tavern.yml");
const exportPath = join(dslDir, "maze-tavern.yml");
const appId = args.get("app-id") ? String(args.get("app-id")) : undefined;

if (!password) throw new Error("DIFY_ADMIN_PASSWORD is required");

const console_ = new DifyConsole(baseUrl);
await console_.bootstrap({ email, name: "MazeKeeper", password, initPassword: password });
console.log("logged in");

const yamlContent = await readFile(dslPath, "utf8");
console.log(`importing ${dslPath} (${Buffer.byteLength(yamlContent, "utf8")} bytes)`);

const payload = {
  mode: "yaml-content",
  yaml_content: yamlContent,
};
if (appId) payload.app_id = appId;

const imported = await console_.post("/console/api/apps/imports", payload);
console.log("import status:", imported.status);
console.log(JSON.stringify(imported.json, null, 2).slice(0, 2000));

if (!imported.ok) {
  throw new Error(`import failed: HTTP ${imported.status} ${imported.text.slice(0, 800)}`);
}

const result = imported.json?.data ?? imported.json;
if (result?.status && result.status !== "completed" && result.status !== "completed-with-warnings") {
  throw new Error(`import did not complete: ${JSON.stringify(result)}`);
}

const importedAppId = result?.app_id;
if (!importedAppId) throw new Error("no app_id in the import result");

// --- export the imported app back to YAML ---------------------------------
// `format=yaml` returns `{"data": "<yaml>"}`; without it the endpoint streams
// an `.ifpkg` zip archive.
const exported = await console_.get(
  `/console/api/apps/${importedAppId}/export?format=yaml&include_secret=false`,
);
if (!exported.ok) {
  throw new Error(`export failed: HTTP ${exported.status} ${exported.text.slice(0, 500)}`);
}

const exportedYaml = exported.json?.data ?? exported.json?.result ?? "";
if (!exportedYaml || !exportedYaml.includes("kind: app")) {
  throw new Error(`unexpected export payload: ${exported.text.slice(0, 500)}`);
}

await writeFile(exportPath, exportedYaml, "utf8");
console.log(`\nexported app ${importedAppId} -> ${exportPath} (${Buffer.byteLength(exportedYaml, "utf8")} bytes)`);
console.log(JSON.stringify({ appId: importedAppId, status: result?.status, warnings: result?.warnings ?? [] }));
