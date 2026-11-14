// Allow the Dify SSRF proxy to reach the session-state service on the host.
//
// Why this is needed
// ------------------
// Dify's HTTP Request node always goes through the `ssrf_proxy` container
// (Squid). Squid's `to_private_networks` ACL denies every private / loopback
// destination, so `http://host.docker.internal:8787/api/state` is refused with
// HTTP 403 and Dify reports
//   "Access to '...' was blocked by SSRF protection".
//
// Dify 1.19.0 ships two escape hatches, both consumed by the proxy's
// `/docker-entrypoint.sh`:
//
//   SSRF_PROXY_ALLOW_PRIVATE_IPS     -> `acl dify_allowed_private_networks dst <cidr...>`
//   SSRF_PROXY_ALLOW_PRIVATE_DOMAINS -> `acl dify_allowed_private_domains dstdomain <domain...>`
//
// The generated ACL file is included *before* the deny rule, so an allowlist
// entry wins.
//
// This script computes the resolved address of `host.docker.internal` at run
// time (no hard-coded address), rewrites the two keys in the compose `.env`,
// recreates the proxy container and verifies the generated squid ACL.
//
// Usage:
//   node scripts/fix-ssrf.mjs [--env <path>] [--compose-dir <dir>]
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);

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

const envPath =
  args.get("env") ??
  process.env.DIFY_DOCKER_ENV ??
  [process.env.LOCALAPPDATA ?? "", "Temp", "opencode", "dify-src", "docker", ".env"].join(
    "\\",
  );
const composeDir =
  args.get("compose-dir") ??
  [process.env.LOCALAPPDATA ?? "", "Temp", "opencode", "dify-src", "docker"].join("\\");

// --- 1. resolve host.docker.internal --------------------------------------
const { stdout: resolved } = await run(
  "docker",
  ["exec", "docker-ssrf_proxy-1", "sh", "-lc", "getent hosts host.docker.internal | awk '{print $1}'"],
  { timeout: 90_000 },
);
const hostAddress = resolved.trim().split(/\s+/)[0];
if (!hostAddress) throw new Error("could not resolve host.docker.internal");
console.log(`host.docker.internal -> ${hostAddress}`);

// --- 2. patch the compose .env --------------------------------------------
let env = await readFile(envPath, "utf8");

function setKey(text, key, value) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  if (pattern.test(text)) return text.replace(pattern, line);
  return `${text.replace(/\s*$/, "")}\n${line}\n`;
}

env = setKey(env, "SSRF_PROXY_ALLOW_PRIVATE_IPS", hostAddress);
env = setKey(env, "SSRF_PROXY_ALLOW_PRIVATE_DOMAINS", "host.docker.internal");

await writeFile(envPath, env, "utf8");
console.log(`patched ${envPath}`);

// --- 3. recreate the proxy container ---------------------------------------
console.log("recreating ssrf_proxy ...");
await run("docker", ["compose", "up", "-d", "--force-recreate", "ssrf_proxy"], {
  cwd: composeDir,
  timeout: 600_000,
});

// --- 4. verify the generated squid ACL -------------------------------------
// The entrypoint writes the ACL file while squid is still booting, so give
// the container a moment before reading it back.
let acl = "";
for (let attempt = 0; attempt < 30; attempt += 1) {
  try {
    const { stdout } = await run(
      "docker",
      ["exec", "docker-ssrf_proxy-1", "sh", "-lc", "cat /etc/squid/dify_allow_private.conf"],
      { timeout: 90_000 },
    );
    acl = stdout;
    if (acl.trim()) break;
  } catch {
    // container not ready yet
  }
  await new Promise((done) => setTimeout(done, 2000));
}
if (!acl.trim()) throw new Error("the proxy never wrote /etc/squid/dify_allow_private.conf");
console.log("\n--- /etc/squid/dify_allow_private.conf ---");
console.log(acl.trim());

const { stdout: included } = await run(
  "docker",
  [
    "exec",
    "docker-ssrf_proxy-1",
    "sh",
    "-lc",
    "grep -n 'include\\|http_access deny to_private_networks' /etc/squid/squid.conf",
  ],
  { timeout: 90_000 },
);
console.log("\n--- squid.conf include order ---");
console.log(included.trim());

const ok =
  acl.includes(hostAddress) && acl.includes("host.docker.internal") && included.includes("include");
console.log(ok ? "\nSSRF ALLOWLIST CONFIGURED" : "\nSSRF ALLOWLIST INCOMPLETE");
process.exit(ok ? 0 : 1);
