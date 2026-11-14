// HTTP surface of the 「迷宮酒館」 session-state service.
//
// The Dify chatflow talks to this service with two HTTP Request nodes:
//
//   GET  /api/state?session_id=...   -> read the session state  (seekdb READ)
//   POST /api/state                   -> write the session state (seekdb WRITE)
//
// Both calls also append a *memory record* (op=read / op=write) so the
// database keeps a complete audit trail of every interaction.
//
// Endpoints
//   GET  /health                      liveness + collection row counts
//   GET  /api/state?session_id=       read state (+ memory read record)
//   GET  /api/context?session_id=     DM briefing in plain text (+ memory read record)
//   POST /api/state                   write state (+ memory write record)
//   GET  /api/memory?session_id=      the memory log of a session
//   GET  /api/search?q=&session_id=   hybrid (full-text + vector) memory search
//   GET  /api/world                   the static world seed (rooms / npcs / items)

import { createServer } from "node:http";

import { config, describeTarget } from "./config.mjs";
import {
  appendMemory,
  close,
  count,
  ensureReady,
  readMemory,
  readState,
  writeState,
} from "./seekdb.mjs";
import { buildContext, oneLine } from "./context.mjs";
import { defaultState, mergeState } from "./state.mjs";
import { WORLD } from "./world.mjs";

const MAX_BODY = 256 * 1024;

function corsHeaders(extra = {}) {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    ...extra,
  };
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    ...corsHeaders(),
  });
  response.end(body);
}

/** Plain-text reply — used by `/api/context`, whose body goes straight into a prompt. */
function sendText(response, status, text) {
  const body = Buffer.from(text, "utf8");
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": body.length,
    ...corsHeaders(),
  });
  response.end(body);
}

/**
 * Read the request body.
 *
 * Two encodings are accepted:
 *   - `application/json`                -> parsed object
 *   - `application/x-www-form-urlencoded` -> flat key/value object
 *
 * The chatflow uses the form encoding on purpose: Dify's Code node sandbox has
 * no `json` module, so the workflow cannot build a JSON string safely. With
 * form encoding every value is percent-encoded by the HTTP client, which keeps
 * the DM's raw `state` JSON intact no matter what the player types.
 */
async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error("request body too large");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};

  const contentType = String(request.headers["content-type"] ?? "").toLowerCase();
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams(raw);
    const parsed = {};
    for (const [key, value] of params.entries()) parsed[key] = value;
    return parsed;
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("request body is not valid JSON");
  }
}

/** Next sequence number for a session's memory log. */
async function nextSeq(sessionId) {
  const { hits } = await readMemory(sessionId, { limit: 200 });
  return hits.reduce((max, hit) => Math.max(max, Number(hit.metadata?.seq ?? 0)), 0) + 1;
}

/** Summarise what changed between two states, for the memory record. */
function describeDelta(before, after) {
  const parts = [];
  if (before.hp !== after.hp) parts.push(`hp ${before.hp}->${after.hp}`);
  if (before.gold !== after.gold) parts.push(`gold ${before.gold}->${after.gold}`);
  if (before.location !== after.location) parts.push(`moved ${before.location}->${after.location}`);
  const beforeItems = new Set(before.inventory ?? []);
  const gained = (after.inventory ?? []).filter((item) => !beforeItems.has(item));
  if (gained.length) parts.push(`+${gained.join("+")}`);
  const newFlags = Object.entries(after.flags ?? {}).filter(
    ([key, value]) => (before.flags ?? {})[key] !== value,
  );
  if (newFlags.length) parts.push(`flags ${newFlags.map(([k, v]) => `${k}=${v}`).join(",")}`);
  return parts.join(" ");
}

/**
 * Salvage the scalar fields of a truncated state block.
 *
 * The DM occasionally runs out of output tokens halfway through the JSON.
 * The workflow's code node closes the document before sending it, so this is
 * only the last line of defence — but it keeps one verbose turn from
 * stalling the whole game.
 */
function salvageState(raw) {
  const text = String(raw ?? "");
  const patch = {};
  for (const key of ["hp", "hp_max", "gold", "turn"]) {
    const match = text.match(new RegExp(`"${key}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`));
    if (match) patch[key] = Number(match[1]);
  }
  const location = text.match(/"location"\s*:\s*"([^"]*)"/);
  if (location) patch.location = location[1];
  return patch;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const path = url.pathname;

  if (request.method === "OPTIONS") {
    sendJson(response, 204, {});
    return;
  }

  try {
    // ---- health --------------------------------------------------------
    if (path === "/health") {
      await ensureReady();
      sendJson(response, 200, {
        ok: true,
        service: "maze-tavern-state-service",
        db: describeTarget(),
        collections: {
          state: { name: config.stateCollection, rows: await count("state") },
          memory: { name: config.memoryCollection, rows: await count("memory") },
        },
        embeddings: config.embeddingModel,
      });
      return;
    }

    // ---- world seed ----------------------------------------------------
    if (path === "/api/world") {
      sendJson(response, 200, WORLD);
      return;
    }

    // ---- read state ----------------------------------------------------
    if (path === "/api/state" && request.method === "GET") {
      const sessionId = url.searchParams.get("session_id")?.trim();
      if (!sessionId) {
        sendJson(response, 400, { ok: false, error: "session_id is required" });
        return;
      }

      const record = await readState(sessionId);
      const state = record?.state ?? defaultState();
      const seq = await nextSeq(sessionId);
      await appendMemory({
        session_id: sessionId,
        seq,
        op: "read",
        turn: Number(state.turn ?? 0),
        location: state.location,
        player_input: url.searchParams.get("q")?.trim() ?? "",
        summary: `read state (${record ? "stored" : "new session"})`,
      });

      // Semantic recall: the player's own words decide which earlier turns
      // matter. `q` is optional; without it the log is returned newest-first.
      const query = url.searchParams.get("q")?.trim() ?? "";
      const limit = Number(url.searchParams.get("limit") ?? config.memoryTopK);
      const recall = await readMemory(sessionId, { limit, query });

      sendJson(response, 200, {
        ok: true,
        session_id: sessionId,
        found: Boolean(record),
        state,
        memory_seq: seq,
        memories: recall.hits.map((hit) => ({
          op: hit.metadata?.op ?? "",
          turn: hit.metadata?.turn ?? 0,
          location: hit.metadata?.location ?? "",
          player_input: hit.metadata?.player_input ?? "",
          summary: hit.metadata?.summary ?? "",
          delta: hit.metadata?.delta ?? "",
          score: hit.score ?? null,
        })),
        recall_mode: recall.mode,
        db: describeTarget(),
      });
      return;
    }

    // ---- turn briefing (plain text) ------------------------------------
    //
    // This is the endpoint the chatflow actually calls every turn. It reads
    // the state row and the memory log out of seekdb and renders a briefing
    // that is injected into the DM prompt verbatim — no JSON parsing needed
    // inside Dify's Code-node sandbox.
    if (path === "/api/context" && request.method === "GET") {
      const sessionId = url.searchParams.get("session_id")?.trim();
      if (!sessionId) {
        sendJson(response, 400, { ok: false, error: "session_id is required" });
        return;
      }

      const query = url.searchParams.get("q")?.trim() ?? "";
      const record = await readState(sessionId);
      const state = record?.state ?? defaultState();

      const seq = await nextSeq(sessionId);
      await appendMemory({
        session_id: sessionId,
        seq,
        op: "read",
        turn: Number(state.turn ?? 0),
        location: state.location,
        player_input: query,
        summary: `read state (${record ? "stored" : "new session"})`,
      });

      const limit = Number(url.searchParams.get("limit") ?? config.memoryTopK);
      const recall = await readMemory(sessionId, { limit, query });
      const history = await readMemory(sessionId, { limit: 50 });

      const text = buildContext({
        state,
        history: history.hits.map((hit) => hit.metadata ?? {}),
        recall: recall.hits.map((hit) => ({
          op: hit.metadata?.op ?? "",
          turn: hit.metadata?.turn ?? 0,
          player_input: hit.metadata?.player_input ?? "",
          delta: hit.metadata?.delta ?? "",
        })),
        recallMode: recall.mode,
        playerInput: query,
      });

      sendText(response, 200, text);
      return;
    }

    // ---- write state ---------------------------------------------------
    if (path === "/api/state" && request.method === "POST") {
      const body = await readBody(request);
      const sessionId = String(body.session_id ?? "").trim();
      if (!sessionId) {
        sendJson(response, 400, { ok: false, error: "session_id is required" });
        return;
      }

      // The workflow sends the DM's `state` block as a raw JSON *string*
      // (`state_raw`) because the Dify code-node sandbox cannot serialise
      // JSON itself. A plain object (`state`) is accepted too.
      let patch = body.state ?? body.patch ?? {};
      let degraded = false;
      let warning = "";
      if (typeof body.state_raw === "string" && body.state_raw.trim()) {
        try {
          patch = JSON.parse(body.state_raw);
        } catch (error) {
          // The DM ran out of output tokens and the state block was cut
          // short. Rejecting the write would lose the whole turn, so the
          // scalar fields are salvaged instead and the degradation is
          // reported back to the workflow.
          degraded = true;
          warning = `state_raw is not valid JSON: ${error?.message ?? error}`;
          patch = salvageState(body.state_raw);
        }
      }

      const existing = await readState(sessionId);
      const before = existing?.state ?? defaultState();
      const after = mergeState(before, patch);
      const narrative = typeof body.narrative === "string"
        ? body.narrative
        : typeof body.last_narrative === "string"
          ? body.last_narrative
          : "";
      if (narrative) after.last_narrative = narrative.slice(0, 4000);

      await writeState(sessionId, after, {
        last_player_input: String(body.player_input ?? "").slice(0, 500),
      });

      const seq = await nextSeq(sessionId);
      await appendMemory({
        session_id: sessionId,
        seq,
        op: "write",
        turn: Number(after.turn ?? 0),
        location: after.location,
        player_input: String(body.player_input ?? ""),
        // The DM's narration is the memory log's payload: it is what lets the
        // next turn's briefing rebuild "what happened" straight from seekdb.
        summary: oneLine(body.summary ?? "") || oneLine(narrative, 400),
        delta: describeDelta(before, after),
      });

      sendJson(response, 200, {
        ok: true,
        session_id: sessionId,
        state: after,
        memory_seq: seq,
        delta: describeDelta(before, after),
        degraded,
        warning,
        db: describeTarget(),
      });
      return;
    }

    // ---- memory log ----------------------------------------------------
    if (path === "/api/memory" && request.method === "GET") {
      const sessionId = url.searchParams.get("session_id")?.trim();
      if (!sessionId) {
        sendJson(response, 400, { ok: false, error: "session_id is required" });
        return;
      }
      const limit = Number(url.searchParams.get("limit") ?? 20);
      const result = await readMemory(sessionId, { limit });
      sendJson(response, 200, {
        ok: true,
        session_id: sessionId,
        mode: result.mode,
        count: result.hits.length,
        entries: result.hits,
      });
      return;
    }

    // ---- hybrid memory search -----------------------------------------
    if (path === "/api/search" && request.method === "GET") {
      const sessionId = url.searchParams.get("session_id")?.trim();
      const query = url.searchParams.get("q")?.trim() ?? "";
      if (!query) {
        sendJson(response, 400, { ok: false, error: "q is required" });
        return;
      }
      const limit = Number(url.searchParams.get("limit") ?? config.memoryTopK);
      const result = await readMemory(sessionId ?? "", { limit, query });
      sendJson(response, 200, {
        ok: true,
        session_id: sessionId,
        query,
        mode: result.mode,
        count: result.hits.length,
        hits: result.hits,
      });
      return;
    }

    sendJson(response, 404, { ok: false, error: `no route for ${request.method} ${path}` });
  } catch (error) {
    sendJson(response, 500, { ok: false, error: error?.message ?? String(error) });
  }
});

// The port is read at listen time (not at import time) so a test harness can
// set `process.env.PORT` before importing this module.
const listenPort = Number.parseInt(process.env.PORT ?? String(config.httpPort), 10);
const listenHost = process.env.HOST ?? config.httpHost;

server.listen(listenPort, listenHost, async () => {
  try {
    await ensureReady();
    console.log(
      `maze-tavern-state-service listening on http://${listenHost}:${listenPort} ` +
        `(seekdb ${describeTarget().mode} @ ${describeTarget().host ?? describeTarget().path}:${describeTarget().port ?? ""})`,
    );
  } catch (error) {
    console.error("failed to initialise seekdb:", error?.message ?? error);
    process.exitCode = 1;
  }
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    server.close();
    await close();
    process.exit(0);
  });
}
