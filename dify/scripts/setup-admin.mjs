// Complete the Dify first-run setup and keep the session cookies.
//
// Usage:
//   node scripts/setup-admin.mjs --email admin@local --name Admin --password '...'
//
// The password for the admin account must also be present as INIT_PASSWORD in
// docker/envs/security.env (Dify validates it before allowing the setup).
import { DifyConsole } from "./dify-client.mjs";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
}

const baseUrl = args.get("base") ?? process.env.DIFY_CONSOLE_URL ?? "http://127.0.0.1:8080";
const email = args.get("email") ?? process.env.DIFY_ADMIN_EMAIL ?? ["admin", "maze.local"].join("@");
const name = args.get("name") ?? process.env.DIFY_ADMIN_NAME ?? "MazeKeeper";
const password = args.get("password") ?? process.env.DIFY_ADMIN_PASSWORD;
const initPassword = args.get("init-password") ?? process.env.DIFY_INIT_PASSWORD ?? password;

if (!password) {
  console.error("missing --password (or DIFY_ADMIN_PASSWORD)");
  process.exit(2);
}

const console_ = new DifyConsole(baseUrl);
const status = await console_.get("/console/api/setup");
console.log("setup status before:", status.text);

const result = await console_.bootstrap({ email, name, password, initPassword });
console.log("bootstrap result:", JSON.stringify(result));

const after = await console_.get("/console/api/setup");
console.log("setup status after :", after.text);
console.log(`admin account: ${email}`);
