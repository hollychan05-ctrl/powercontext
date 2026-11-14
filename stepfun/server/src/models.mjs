// Local model-file proxy.
//
// Why this exists: the browser cannot reliably fetch the ONNX weights straight from
// the model hub.
//   * `huggingface.co` is unreachable on some networks (connection timeout).
//   * `hf-mirror.com` answers the first request with CORS headers, but its redirect
//     target (`/api/resolve-cache/...`) does not send `Access-Control-Allow-Origin`
//     for `GET`, so the browser blocks the response.
// Node's fetch has no such restriction, so the backend fetches the file and streams it
// back same-origin. Only model *weights* pass through here — inference stays in the
// browser, nothing is computed server-side.
//
// Two details that matter in practice:
//   * The upstream is resolved by racing all candidates with a short timeout and
//     caching the winner, so one unreachable host never delays every request.
//   * The timeout only covers the *response headers*. The weight file itself takes
//     ~60 s to transfer, and aborting mid-body would truncate the response.

import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// Upstream hosts, raced in parallel. The first one that answers wins.
export const upstreamHosts = (process.env.MODEL_UPSTREAM_HOSTS
  ?? "https://huggingface.co/,https://hf-mirror.com/")
  .split(",")
  .map((host) => host.trim())
  .filter(Boolean);

// How long a single upstream attempt may take to produce response headers.
const UPSTREAM_TIMEOUT_MS = Number(process.env.MODEL_UPSTREAM_TIMEOUT_MS ?? 8000);
// How long a whole upstream transfer (headers + body) may take.
const UPSTREAM_TOTAL_TIMEOUT_MS = Number(process.env.MODEL_UPSTREAM_TOTAL_TIMEOUT_MS ?? 600_000);

// Where downloaded weights are cached so the second run does not re-download 23 MB.
const CACHE_DIR = resolve(here, "..", "..", ".cache", "models");

// The host that answered last time; sticky so normal traffic pays no race cost.
let activeHost = null;

/** Parse `/model/<repo>/resolve/<revision>/<file...>` into its parts. */
export function parseModelPath(pathname) {
  const match = /^\/model\/(.+)\/resolve\/([^/]+)\/(.+)$/.exec(pathname ?? "");
  if (!match) return null;
  return { repo: match[1], revision: match[2], file: match[3] };
}

export function upstreamUrl(host, { repo, revision, file }) {
  return `${host.replace(/\/$/, "")}/${repo}/resolve/${revision}/${file}`;
}

/** Cache location for one model file. */
function cachePath(part) {
  const safe = `${part.repo}/${part.revision}/${part.file}`.replace(/[^a-zA-Z0-9._-]+/g, "_");
  return join(CACHE_DIR, safe);
}

/**
 * Race every upstream host and return the first usable response.
 * Returns `{ response, host }` or `null` when nobody answered.
 */
async function fetchFromUpstreams(part, method, extraHeaders = {}) {
  if (activeHost) {
    const cached = await tryHost(activeHost, part, method, extraHeaders);
    if (cached) return cached;
    activeHost = null; // cached host broke — fall through to a fresh race
  }

  // True race: resolve with the first host that answers, not with the slowest one.
  return new Promise((resolvePromise) => {
    let pending = upstreamHosts.length;
    if (pending === 0) {
      resolvePromise(null);
      return;
    }
    for (const host of upstreamHosts) {
      tryHost(host, part, method, extraHeaders).then((result) => {
        if (result) {
          activeHost = result.host;
          resolvePromise(result);
          return;
        }
        pending -= 1;
        if (pending === 0) resolvePromise(null);
      });
    }
  });
}

/**
 * One upstream attempt. Returns `{ response, host, cleanup }` or null.
 * `cleanup` must be called once the body has been transferred.
 */
async function tryHost(host, part, method, extraHeaders) {
  const url = upstreamUrl(host, part);
  const controller = new AbortController();
  const headerTimer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  const totalTimer = setTimeout(() => controller.abort(), UPSTREAM_TOTAL_TIMEOUT_MS);
  const cleanup = () => {
    clearTimeout(headerTimer);
    clearTimeout(totalTimer);
  };
  try {
    const response = await fetch(url, {
      method,
      redirect: "follow",
      headers: { "user-agent": "stepfun-edge-kb/1.0", ...extraHeaders },
      signal: controller.signal,
    });
    // Headers are in — the body may still need minutes, so the short timeout is done.
    clearTimeout(headerTimer);
    if (!response.ok) {
      cleanup();
      return null;
    }
    return { response, host, cleanup };
  } catch {
    cleanup();
    return null;
  }
}

/**
 * Stream a model file to the client.
 * `method` is GET (body) or HEAD (size probe only).
 */
export async function proxyModelFile(part, method, res) {
  // A cached copy answers immediately and gives an exact content-length.
  const target = cachePath(part);
  if (existsSync(target)) {
    const size = statSync(target).size;
    res.writeHead(200, {
      "content-type": contentTypeFor(part.file),
      "content-length": String(size),
      "cache-control": "public, max-age=86400",
      "access-control-allow-origin": "*",
      "x-model-cache": "hit",
    });
    if (method === "HEAD") {
      res.end();
      return { host: activeHost, file: part.file, bytes: size, cached: true };
    }
    const { createReadStream } = await import("node:fs");
    await new Promise((done) => {
      const stream = createReadStream(target);
      stream.on("error", () => {
        res.destroy();
        done();
      });
      stream.on("end", done);
      stream.pipe(res);
    });
    return { host: activeHost, file: part.file, bytes: size, cached: true };
  }

  const found = await fetchFromUpstreams(part, method);
  if (!found) {
    res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({
        error: "no model host reachable",
        hosts: upstreamHosts,
        timeoutMs: UPSTREAM_TIMEOUT_MS,
      }),
    );
    return null;
  }

  const { response, host, cleanup } = found;
  const headers = {
    "content-type": response.headers.get("content-type") ?? contentTypeFor(part.file),
    "cache-control": "public, max-age=86400",
    "access-control-allow-origin": "*",
    "x-upstream-host": host,
  };
  const length = response.headers.get("content-length");
  // The mirror reports a bogus length for small files on HEAD, so only trust it when
  // the upstream gave us one for the actual body.
  if (length) headers["content-length"] = length;

  res.writeHead(200, headers);
  if (method === "HEAD" || !response.body) {
    res.end();
    cleanup();
    return { host, file: part.file, bytes: length ? Number(length) : null };
  }

  // Stream to the client and, at the same time, into the cache.
  mkdirSync(dirname(target), { recursive: true });
  const temp = `${target}.part`;
  const sink = createWriteStream(temp);
  let written = 0;
  try {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      written += chunk.length;
      sink.write(chunk);
      res.write(chunk);
    }
    res.end();
    sink.end();
    await new Promise((done) => sink.on("finish", done));
    renameSync(temp, target);
  } catch (error) {
    res.destroy(error);
    try {
      sink.destroy();
      unlinkSync(temp);
    } catch {
      // ignore
    }
  } finally {
    cleanup();
  }
  return { host, file: part.file, bytes: written };
}

function contentTypeFor(file) {
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  if (file.endsWith(".onnx")) return "application/octet-stream";
  if (file.endsWith(".txt")) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

/** Exposed for diagnostics: which upstream is currently in use. */
export function activeUpstream() {
  return activeHost;
}
