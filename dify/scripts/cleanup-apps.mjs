// Remove duplicate 「迷宮酒館」 apps, keeping the newest one.
//
// Usage:
//   node scripts/cleanup-apps.mjs            # keep the newest
//   node scripts/cleanup-apps.mjs --keep <uuid>
import { DifyConsole } from "./dify-client.mjs";

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

const console_ = new DifyConsole(baseUrl);
await console_.bootstrap({ email, name: "MazeKeeper", password, initPassword: password });

const list = await console_.get("/console/api/apps?page=1&limit=100&include_all=true");
const apps = list?.json?.data ?? [];
const matches = apps.filter((app) => app.name === appName);
console.log(`${matches.length} app(s) named ${appName}`);

const keep = args.get("keep") ? String(args.get("keep")) : matches[0]?.id;
if (!keep) {
  console.log("nothing to clean up");
  process.exit(0);
}

for (const app of matches) {
  if (app.id === keep) {
    console.log(`keep   ${app.id} (${app.created_at})`);
    continue;
  }
  const deleted = await console_.delete(`/console/api/apps/${app.id}`);
  console.log(`delete ${app.id} -> HTTP ${deleted.status}`);
}
