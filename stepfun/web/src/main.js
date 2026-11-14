import { api } from "./api.js";
import { Embedder, modelFileSize, modelSources, webgpuAvailable } from "./embedder.js";
import { ndcgAtK, recallAtK } from "./metrics.js";

const $ = (id) => document.getElementById(id);
const embedder = new Embedder();

// Debug hook: lets you inspect the live state from the console (and from automated
// browser tests) without touching the UI.
window.__kb = { embedder, api };

// ----- performance bookkeeping (cold = first, warm = last) ---------------------
const PERF_STAGES = [
  ["model_load", "模型加载"],
  ["doc_embed", "文档向量化"],
  ["ingest", "写入 seekdb"],
  ["query_embed", "查询向量化"],
  ["seekdb_search", "seekdb 检索"],
  ["end_to_end", "端到端（提交→结果）"],
];
const perf = Object.fromEntries(PERF_STAGES.map(([key]) => [key, { cold: null, warm: null }]));

function record(stage, ms) {
  const slot = perf[stage];
  if (!slot) return;
  if (slot.cold === null) slot.cold = ms;
  slot.warm = ms;
  renderPerf();
}

function renderPerf() {
  $("perf-body").innerHTML = PERF_STAGES.map(([key, label]) => {
    const slot = perf[key];
    const fmt = (v) => (v === null ? "—" : `${v.toFixed(1)} ms`);
    return `<tr><td>${label}</td><td>${fmt(slot.cold)}</td><td>${fmt(slot.warm)}</td></tr>`;
  }).join("");
}
renderPerf();

// ----- helpers -----------------------------------------------------------------
function formatBytes(bytes) {
  if (!bytes) return "未知";
  const mb = bytes / 1024 / 1024;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`;
}

function setBadge(id, text, tone) {
  const el = $(id);
  el.textContent = text;
  el.className = `badge badge-${tone}`;
}

function parseCorpusText(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.map((line, index) => ({ id: `doc-${index + 1}`, text: line, metadata: {} }));
}

let sampleDocs = null; // documents loaded from /api/corpus (stable ids for evaluation)
let evalSet = null;

// ----- backend binding ---------------------------------------------------------
async function connect() {
  try {
    const health = await api.health();
    setBadge("backend-badge", `后端：已连接（seekdb ${health.target.mode}）`, "ok");
    $("clear-db").dataset.ready = "1";
  } catch (error) {
    setBadge("backend-badge", "后端：未连接（请先启动 server）", "err");
    console.warn(error);
  }
}
connect();

// ----- model -------------------------------------------------------------------
async function renderModelSizes(model) {
  const host = embedder.remoteHost ?? modelSources().auto.hosts[0];
  const [fp32, fp16, q8] = await Promise.all([
    modelFileSize(model, "fp32", host),
    modelFileSize(model, "fp16", host),
    modelFileSize(model, "q8", host),
  ]);
  const ratio = fp32 && q8 ? `，压缩比 fp32/INT8=${(fp32 / q8).toFixed(2)}×` : "";
  $("model-info").innerHTML = [
    `WebGPU 可用：<b>${webgpuAvailable() ? "是" : "否"}</b>`,
    `模型体积：fp32=${formatBytes(fp32)} · fp16=${formatBytes(fp16)} · INT8=${formatBytes(q8)}${ratio}`,
    `体积来源：${host}`,
  ].join("<br />");
}

$("load-model").addEventListener("click", async () => {
  const model = $("model-select").value;
  const dtype = $("dtype-select").value;
  const device = $("device-select").value;
  const source = $("source-select").value;
  $("load-model").disabled = true;
  $("load-model").textContent = "加载中…";
  try {
    const info = await embedder.load({ model, dtype, device, source });
    record("model_load", info.loadMs);
    setBadge("device-badge", `推理后端：${info.device.toUpperCase()}`, info.device === "webgpu" ? "ok" : "warn");
    setBadge("model-badge", `模型：${model.split("/").pop()} · ${info.dtype}`, "ok");
    await renderModelSizes(model);
    const fallback = info.fallbackReason ? `<br />${info.fallbackReason}` : "";
    const probes = (info.hostProbes ?? [])
      .map((probe) => `${probe.host.replace(/^https:\/\//, "").replace(/\/$/, "")}=${probe.ok ? "可达" : "不可达"}`)
      .join(" · ");
    $("model-info").insertAdjacentHTML(
      "beforeend",
      `<br />维度：${info.dimension} · 加载耗时：${info.loadMs.toFixed(1)} ms · 后端：${info.device} · 模型源：${info.remoteHost}` +
        `${fallback}<br />源探测：${probes}`,
    );
  } catch (error) {
    setBadge("model-badge", `模型加载失败：${error.message}`, "err");
  } finally {
    $("load-model").disabled = false;
    $("load-model").textContent = "加载模型";
  }
});

$("model-select").addEventListener("change", (event) => renderModelSizes(event.target.value));
$("source-select").addEventListener("change", (event) => renderModelSizes($("model-select").value));
renderModelSizes($("model-select").value);

// ----- corpus ------------------------------------------------------------------
$("load-sample").addEventListener("click", async () => {
  sampleDocs = await api.corpus();
  $("corpus-input").value = sampleDocs.map((doc) => doc.text).join("\n");
  evalSet = await api.evalSet();
  $("ingest-progress").textContent = `已载入示例语料 ${sampleDocs.length} 条，评测集 ${evalSet.queries?.length ?? 0} 条。`;
});

$("file-input").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  const text = await file.text();
  if (file.name.endsWith(".jsonl")) {
    sampleDocs = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .map((doc, index) => ({ id: String(doc.id ?? `doc-${index + 1}`), text: String(doc.text), metadata: doc.metadata ?? {} }));
    $("corpus-input").value = sampleDocs.map((doc) => doc.text).join("\n");
  } else {
    sampleDocs = null;
    $("corpus-input").value = text;
  }
});

$("clear-db").addEventListener("click", async () => {
  if (!confirm("确认清空 seekdb 中的全部文档？")) return;
  await api.reset();
  $("ingest-progress").textContent = "数据库已清空。";
  $("results").innerHTML = "";
});

$("ingest").addEventListener("click", async () => {
  if (!embedder.ready) return alert("请先加载模型。");
  const raw = $("corpus-input").value.trim();
  if (!raw) return alert("请先输入或载入语料。");
  const docs =
    sampleDocs && sampleDocs.length === raw.split(/\r?\n/).filter((line) => line.trim()).length
      ? sampleDocs
      : parseCorpusText(raw);
  if (docs.some((doc) => doc.text.length === 0)) return alert("存在空文档。");

  $("ingest").disabled = true;
  const t0 = performance.now();
  try {
    $("ingest-progress").textContent = `向量化 0/${docs.length}…`;
    const docStart = performance.now();
    const vectors = await embedder.embedBatched(docs, 8, (done, total) => {
      $("ingest-progress").textContent = `向量化 ${done}/${total}…`;
    });
    const docMs = performance.now() - docStart;
    record("doc_embed", docMs);

    const items = docs.map((doc, index) => ({ ...doc, embedding: vectors[index] }));
    const writeStart = performance.now();
    await api.ingest(items);
    record("ingest", performance.now() - writeStart);

    // Prove the freshly written row is retrievable after the write/refresh.
    const probe = await api.verify(docs[0].id, vectors[0]);
    const refreshed =
      probe.rank !== null
        ? `，刷新后 ${docs[0].id} 命中第 ${probe.rank} 位`
        : probe.indexed
          ? `，刷新后 ${docs[0].id} 已在索引中（向量相似度排名靠后）`
          : "（刷新校验未命中）";
    const stats = await api.stats();
    $("ingest-progress").textContent = `写入 ${docs.length} 条完成；库内共 ${stats.count} 条${refreshed}；文档向量化 ${docMs.toFixed(0)} ms。`;
    record("end_to_end", performance.now() - t0);
  } catch (error) {
    $("ingest-progress").textContent = `写入失败：${error.message}`;
  } finally {
    $("ingest").disabled = false;
  }
});

// ----- search ------------------------------------------------------------------
$("search").addEventListener("click", async () => {
  if (!embedder.ready) return alert("请先加载模型。");
  const query = $("query-input").value.trim();
  if (!query) return alert("请输入查询。");
  const mode = $("mode-select").value;
  const nResults = Number($("nresults-select").value);
  $("search").disabled = true;
  const t0 = performance.now();
  try {
    const embedStart = performance.now();
    const [vector] = await embedder.embed([query]);
    record("query_embed", performance.now() - embedStart);

    const searchStart = performance.now();
    const result = await api.search({ query, embedding: vector, nResults, mode });
    record("seekdb_search", performance.now() - searchStart);

    renderResults(result);
    record("end_to_end", performance.now() - t0);
  } catch (error) {
    $("results").innerHTML = `<li class="err">检索失败：${error.message}</li>`;
  } finally {
    $("search").disabled = false;
  }
});

function renderResults(result) {
  if (!result.hits.length) {
    $("results").innerHTML = `<li class="muted">没有命中（可先导入语料）。</li>`;
    return;
  }
  $("results").innerHTML = result.hits
    .map((hit, index) => {
      const distance = hit.distance === null ? "—" : hit.distance.toFixed(4);
      const meta = hit.metadata ? JSON.stringify(hit.metadata) : "";
      return `<li>
        <div class="hit-head"><span class="rank">${index + 1}</span><code>${hit.id}</code>
          <span class="dist">distance=${distance}</span><span class="mode">${result.mode}</span></div>
        <div class="hit-text">${escapeHtml(hit.document ?? "")}</div>
        <div class="hit-meta">${escapeHtml(meta)}</div>
      </li>`;
    })
    .join("");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

// ----- quality evaluation (metrics live in ./metrics.js, shared with the unit test) -----
$("run-eval").addEventListener("click", async () => {
  if (!embedder.ready) return alert("请先加载模型。");
  if (!evalSet) evalSet = await api.evalSet();
  const queries = evalSet.queries ?? [];
  if (!queries.length) return alert("评测集为空（请先“载入示例语料”）。");
  const k = Math.max(1, Number($("eval-k").value) || 5);
  $("run-eval").disabled = true;
  $("eval-status").textContent = "评测中…";
  try {
    let recallSum = 0;
    let ndcgSum = 0;
    let counted = 0;
    for (const item of queries) {
      const [vector] = await embedder.embed([item.query]);
      const result = await api.search({ query: item.query, embedding: vector, nResults: k + 10, mode: "hybrid" });
      const ranked = result.hits.map((hit) => hit.id);
      const relevant = new Set((item.relevant ?? []).map(String));
      const recall = recallAtK(ranked, relevant, k);
      const ndcg = ndcgAtK(ranked, relevant, k);
      if (recall !== null) recallSum += recall;
      if (ndcg !== null) ndcgSum += ndcg;
      counted += 1;
    }
    const info = embedder.describe();
    const label = `${info.model.split("/").pop()} · ${info.dtype}`;
    const row = `<tr><td>${label}</td><td>${info.device}</td><td>${(recallSum / counted).toFixed(4)}</td><td>${(ndcgSum / counted).toFixed(4)}</td><td>${counted}</td></tr>`;
    $("eval-table").querySelector("tbody").insertAdjacentHTML("beforeend", row);
    $("eval-status").textContent = `完成：K=${k}`;
  } catch (error) {
    $("eval-status").textContent = `评测失败：${error.message}`;
  } finally {
    $("run-eval").disabled = false;
  }
});
