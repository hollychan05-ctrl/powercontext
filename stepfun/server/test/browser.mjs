// Browser end-to-end test: drives the real UI in headless Chrome/Edge over the
// Chrome DevTools Protocol, so the whole chain is exercised for real:
//
//   browser (Transformers.js, WebGPU→WASM)  ->  HTTP API  ->  seekdb (hybrid search)
//
//   node server/test/browser.mjs
//
// Requires a reachable seekdb (SEEKDB_MODE=server). Set BROWSER to choose the binary
// and CHROME_ARGS to override the launch flags.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { config } from "../src/config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(here, "..", "src", "index.mjs");

const PORT = process.env.API_TEST_PORT ?? "8801";
const DEBUG_PORT = process.env.CDP_PORT ?? "9333";
const BASE = `http://127.0.0.1:${PORT}`;

const BROWSER_CANDIDATES = [
  process.env.BROWSER,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);

function findBrowser() {
  return BROWSER_CANDIDATES.find((candidate) => existsSync(candidate));
}

// ---------------------------------------------------------------- minimal CDP client
class Cdp {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
  }

  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolvePromise, rejectPromise) => {
      this.ws.addEventListener("open", resolvePromise, { once: true });
      this.ws.addEventListener("error", rejectPromise, { once: true });
    });
    this.ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve: ok, reject: fail } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) fail(new Error(`${message.error.message} (${JSON.stringify(message.error.data ?? "")})`));
        else ok(message.result);
      } else if (message.method) {
        this.events.push(message);
        if (message.method === "Runtime.consoleAPICalled") {
          const text = (message.params.args ?? [])
            .map((arg) => arg.value ?? arg.description ?? arg.unserializableValue ?? "")
            .join(" ");
          console.log(`[page:${message.params.type}] ${text}`);
        } else if (message.method === "Runtime.exceptionThrown") {
          const details = message.params.exceptionDetails;
          console.log(`[page:exception] ${details.exception?.description ?? details.text}`);
        } else if (message.method === "Log.entryAdded") {
          console.log(`[page:log:${message.params.entry.level}] ${message.params.entry.text}`);
        }
      }
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((ok, fail) => {
      this.pending.set(id, { resolve: ok, reject: fail });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Evaluate an expression in the page and return its value. */
  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(`page exception: ${result.exceptionDetails.exception?.description ?? "unknown"}`);
    }
    return result.result?.value;
  }

  /**
   * Poll a boolean expression until true (or timeout).
   * `describe` is an optional expression whose value is reported when the wait fails,
   * so a timeout says *what* the page looked like instead of just "timed out".
   */
  async waitFor(expression, timeoutMs, label, describe = null) {
    const state = describe
      ? `let state = ""; try { state = ${describe}; } catch (e) { state = String(e); }
         throw new Error("timeout waiting for ${label} | state: " + state);`
      : `throw new Error("timeout waiting for ${label}");`;
    const body = `(async () => {
      const deadline = Date.now() + ${timeoutMs};
      while (Date.now() < deadline) {
        try { if (${expression}) return true; } catch (e) {}
        await new Promise((r) => setTimeout(r, 200));
      }
      ${state}
    })()`;
    return this.evaluate(body);
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }
}

// ------------------------------------------------------------------------- page logic
// NOTE: every helper returns a *parenthesised* expression — `a?.textContent ?? ""` has
// lower precedence than `.includes(...)`, so an unparenthesised form silently compares
// the fallback string instead of the badge text.
const helpers = {
  text: (id) => `(document.getElementById(${JSON.stringify(id)})?.textContent ?? "")`,
  click: (id) => `document.getElementById(${JSON.stringify(id)}).click()`,
  setSelect: (id, value) =>
    `(() => { const el = document.getElementById(${JSON.stringify(id)}); el.value = ${JSON.stringify(value)};` +
    ` el.dispatchEvent(new Event("change", { bubbles: true })); return el.value; })()`,
  setInput: (id, value) =>
    `(() => { const el = document.getElementById(${JSON.stringify(id)}); el.value = ${JSON.stringify(value)};` +
    ` el.dispatchEvent(new Event("input", { bubbles: true })); return el.value; })()`,
};

async function main() {
  const browserPath = findBrowser();
  if (!browserPath) throw new Error(`no browser found; tried:\n${BROWSER_CANDIDATES.join("\n")}`);
  console.log(`browser: ${browserPath}`);
  console.log(`seekdb: mode=${config.mode} collection=${config.collection} dim=${config.dimension}`);

  // 1) backend
  const server = spawn(process.execPath, [serverEntry], {
    env: { ...process.env, PORT },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (chunk) => process.stdout.write(`[server] ${chunk}`));
  server.stderr.on("data", (chunk) => process.stderr.write(`[server] ${chunk}`));

  // 2) browser
  const profile = mkdtempSync(join(tmpdir(), "stepfun-chrome-"));
  const args = [
    "--headless=new",
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-features=Translate,OptimizationHints",
    ...(process.env.CHROME_ARGS ? process.env.CHROME_ARGS.split(" ").filter(Boolean) : []),
    "about:blank",
  ];
  const browser = spawn(browserPath, args, { stdio: ["ignore", "pipe", "pipe"] });
  browser.stderr.on("data", () => {});

  let cdp = null;
  try {
    // wait for the debugger endpoint
    let version = null;
    for (let i = 0; i < 100 && !version; i += 1) {
      await new Promise((r) => setTimeout(r, 200));
      try {
        version = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`).then((r) => r.json());
      } catch {
        // not up yet
      }
    }
    if (!version) throw new Error("browser debugger endpoint never came up");
    console.log(`browser: ${version.Browser}`);

    // attach to the page target
    let targets = [];
    for (let i = 0; i < 50; i += 1) {
      targets = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`).then((r) => r.json());
      if (targets.some((t) => t.type === "page")) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const page = targets.find((t) => t.type === "page");
    if (!page) throw new Error("no page target");
    cdp = new Cdp(page.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");

    // 3) open the app
    await cdp.send("Page.navigate", { url: `${BASE}/` });
    await cdp.waitFor(`document.readyState === "complete"`, 30_000, "page load");
    await cdp.waitFor(`${helpers.text("backend-badge")}.includes("已连接")`, 60_000, "backend connected");
    console.log("backend badge:", await cdp.evaluate(helpers.text("backend-badge")));

    // 4) load the model in the browser (this is the end-side inference path)
    const probe = await cdp.evaluate(
      `(async () => { const h = location.origin + "/model/";` +
        ` try { const r = await fetch(h + "Xenova/all-MiniLM-L6-v2/resolve/main/config.json", { method: "HEAD" });` +
        ` return { url: h, status: r.status, ok: r.ok, len: r.headers.get("content-length") }; }` +
        ` catch (e) { return { url: h, error: String(e) }; } })()`,
    );
    console.log("proxy probe:", JSON.stringify(probe));

    await cdp.evaluate(helpers.setSelect("model-select", "Xenova/all-MiniLM-L6-v2"));
    await cdp.evaluate(helpers.setSelect("dtype-select", "q8"));
    await cdp.evaluate(helpers.setSelect("source-select", "auto"));
    await cdp.evaluate(helpers.setSelect("device-select", "auto"));
    await cdp.evaluate(helpers.click("load-model"));
    console.log("loading model in the browser (this downloads the ONNX weights)...");

    const modelFailed = await cdp.waitFor(
      `${helpers.text("model-badge")}.includes("失败")`,
      5_000,
      "model failure badge (gives up early on error)",
    ).catch(() => false);
    if (modelFailed) {
      throw new Error(`model failed to load: ${await cdp.evaluate(helpers.text("model-badge"))}`);
    }
    // The idle badge reads "模型：未加载"; a loaded one reads "模型：<name> · <dtype>".
    await cdp.waitFor(
      `${helpers.text("model-badge")}.startsWith("模型：") && !${helpers.text("model-badge")}.includes("未加载")`,
      600_000,
      "model loaded",
      `(${helpers.text("model-badge")}) + " / " + (${helpers.text("device-badge")}) + " / " + (${helpers.text("model-info")})`,
    );
    console.log("model badge:", await cdp.evaluate(helpers.text("model-badge")));
    console.log("device badge:", await cdp.evaluate(helpers.text("device-badge")));
    console.log("model info:", await cdp.evaluate(helpers.text("model-info")));

    // 5) import the sample corpus -> browser-side embedding -> seekdb
    await cdp.evaluate(helpers.click("load-sample"));
    await cdp.waitFor(`document.getElementById("corpus-input").value.length > 0`, 30_000, "corpus loaded");
    const corpusLines = await cdp.evaluate(`document.getElementById("corpus-input").value.split(/\\r?\\n/).filter(Boolean).length`);
    console.log("corpus lines:", corpusLines);

    await cdp.evaluate(helpers.click("ingest"));
    await cdp.waitFor(
      `${helpers.text("ingest-progress")}.includes("写入") && !${helpers.text("ingest-progress")}.includes("写入中")`,
      300_000,
      "ingest finished",
    );
    console.log("ingest:", await cdp.evaluate(helpers.text("ingest-progress")));

    // 6) search through the UI
    await cdp.evaluate(helpers.setInput("query-input", "How does hybrid search combine keyword and vector results?"));
    await cdp.evaluate(helpers.setSelect("mode-select", "hybrid"));
    await cdp.evaluate(helpers.setSelect("nresults-select", "5"));
    await cdp.evaluate(helpers.click("search"));
    await cdp.waitFor(`document.querySelectorAll("#results li").length > 0`, 120_000, "search results");
    const results = await cdp.evaluate(`document.getElementById("results").innerText`);
    console.log("--- results ---");
    console.log(results);
    console.log("----------------");

    // 7) quality evaluation in the browser (Recall@K / nDCG@K)
    await cdp.evaluate(helpers.click("run-eval"));
    await cdp.waitFor(
      `${helpers.text("eval-status")}.includes("完成") || ${helpers.text("eval-status")}.includes("失败")`,
      300_000,
      "evaluation finished",
    );
    console.log("eval status:", await cdp.evaluate(helpers.text("eval-status")));
    console.log("eval table:", await cdp.evaluate(`document.getElementById("eval-table").innerText`));
    console.log("perf table:", await cdp.evaluate(`document.getElementById("perf-body").innerText`));

    // 8) assertions
    assert.ok(corpusLines >= 16, "sample corpus should have 16 documents");
    assert.match(results, /hybrid-search/, "hybrid retrieval must surface the matching document");
    const perf = await cdp.evaluate(`document.getElementById("perf-body").innerText`);
    assert.match(perf, /模型加载/, "perf table must record the model load stage");

    console.log("\nbrowser OK");
  } finally {
    cdp?.close();
    browser.kill("SIGKILL");
    server.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 500));
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

main().catch((error) => {
  console.error("browser FAILED:", error);
  process.exitCode = 1;
});
