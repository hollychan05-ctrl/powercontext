// Local backend: JSON API for storage/retrieval + static hosting of the browser app.
//
// The HTML/JS in ../web performs all embedding locally (WebGPU, falling back to WASM)
// and sends only text + vectors here. Retrieval is executed by seekdb.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

import { config } from "./config.mjs";
import { close, ensureReady, ingest, reset, search, stats, verify } from "./seekdb.mjs";
import { parseModelPath, proxyModelFile, upstreamHosts } from "./models.mjs";

const WEB_ROOT = resolve(config.projectRoot, "web");
const DATA_ROOT = resolve(config.projectRoot, "data");
const MAX_BODY_BYTES = 16 * 1024 * 1024;

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jsonl": "application/x-ndjson; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("request body must be valid JSON");
  }
}

async function serveStatic(res, root, relativePath) {
  const safe = normalize(relativePath).replace(/^(\.\.[/\\])+/, "");
  const target = join(root, safe);
  if (!target.startsWith(root)) {
    sendJson(res, 403, { error: "forbidden" });
    return;
  }
  try {
    const body = await readFile(target);
    res.writeHead(200, {
      "content-type": CONTENT_TYPES[extname(target).toLowerCase()] ?? "application/octet-stream",
      "content-length": body.length,
    });
    res.end(body);
  } catch {
    sendJson(res, 404, { error: "not found", path: relativePath });
  }
}

async function handleApi(req, res, pathname) {
  if (req.method === "GET" && pathname === "/api/health") {
    await ensureReady();
    sendJson(res, 200, { ok: true, ...(await stats()) });
    return true;
  }
  if (req.method === "GET" && pathname === "/api/stats") {
    sendJson(res, 200, await stats());
    return true;
  }
  if (req.method === "POST" && pathname === "/api/ingest") {
    const body = await readJsonBody(req);
    sendJson(res, 200, await ingest(body.items ?? []));
    return true;
  }
  if (req.method === "POST" && pathname === "/api/search") {
    const body = await readJsonBody(req);
    sendJson(res, 200, await search(body));
    return true;
  }
  if (req.method === "POST" && pathname === "/api/verify") {
    const body = await readJsonBody(req);
    sendJson(res, 200, await verify(body.id, body.embedding));
    return true;
  }
  if (req.method === "POST" && pathname === "/api/reset") {
    sendJson(res, 200, await reset());
    return true;
  }
  if (req.method === "GET" && pathname === "/api/corpus") {
    await serveStatic(res, DATA_ROOT, "corpus.jsonl");
    return true;
  }
  if (req.method === "GET" && pathname === "/api/eval") {
    await serveStatic(res, DATA_ROOT, "eval.json");
    return true;
  }
  if (req.method === "GET" && pathname === "/api/model-hosts") {
    sendJson(res, 200, { hosts: upstreamHosts });
    return true;
  }
  return false;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const pathname = decodeURIComponent(url.pathname);
  try {
    if (pathname.startsWith("/api/")) {
      if (await handleApi(req, res, pathname)) return;
      sendJson(res, 404, { error: "unknown endpoint", path: pathname });
      return;
    }
    // Model-file proxy: the browser fetches the ONNX weights same-origin so it is not
    // blocked by CORS or by an unreachable model hub.
    if (pathname.startsWith("/model/")) {
      const part = parseModelPath(pathname);
      if (!part) {
        sendJson(res, 404, { error: "bad model path", path: pathname });
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        sendJson(res, 405, { error: "method not allowed" });
        return;
      }
      await proxyModelFile(part, req.method, res);
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    await serveStatic(res, WEB_ROOT, pathname === "/" ? "index.html" : pathname.slice(1));
  } catch (error) {
    sendJson(res, 500, { error: String(error?.message ?? error) });
  }
});

server.listen(config.httpPort, () => {
  const target = config.mode === "embedded" ? config.path : `${config.host}:${config.port}`;
  console.log(`[stepfun-edge-kb] backend listening on http://127.0.0.1:${config.httpPort}`);
  console.log(`[stepfun-edge-kb] seekdb mode=${config.mode} target=${target} collection=${config.collection}`);
  console.log(`[stepfun-edge-kb] open http://127.0.0.1:${config.httpPort}/ in Chrome/Edge`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await close().catch(() => {});
    server.close(() => process.exit(0));
  });
}
