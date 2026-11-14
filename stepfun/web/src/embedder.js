// Browser-side embedding.
//
// Everything here runs on the user's device: Transformers.js loads an ONNX embedding
// model, picks WebGPU when available and transparently falls back to the WASM backend.
// No text or vector ever leaves the machine for inference — only stored vectors/text
// are sent to the local seekdb backend.
//
// Model host handling: `huggingface.co` is not reachable from every network and
// `hf-mirror.com` serves its redirect target without CORS headers, so the browser
// often cannot load weights straight from a model hub. The backend therefore exposes a
// same-origin proxy (`/model/<repo>/resolve/<rev>/<file>`) which relays *weights*
// only — inference still happens on the device. The direct hosts stay selectable for
// networks where they work.

import { env, pipeline } from "@huggingface/transformers";

export const MODELS = {
  "Xenova/all-MiniLM-L6-v2": { dimension: 384, note: "轻量通用，英文/多语混排" },
  "Xenova/bge-small-en-v1.5": { dimension: 384, note: "英文检索效果较好" },
};

// Direct model hosts. Transformers.js builds URLs as
// `${env.remoteHost}${env.remotePathTemplate}`.
export const MODEL_HOSTS = ["https://huggingface.co/", "https://hf-mirror.com/"];

/**
 * The backend exposes a same-origin model proxy (`/model/<repo>/resolve/<rev>/<file>`).
 * It is the default because the model hub is frequently unusable straight from a
 * browser. The proxy only relays weights — inference stays on the user's device.
 */
export function localProxyHost() {
  return typeof location !== "undefined" ? `${location.origin}/model/` : "/model/";
}

export function modelSources() {
  return {
    auto: { label: "自动（优先本地代理）", hosts: [localProxyHost(), ...MODEL_HOSTS] },
    proxy: { label: "本地后端代理（推荐）", hosts: [localProxyHost()] },
    huggingface: { label: "huggingface.co（直连）", hosts: ["https://huggingface.co/"] },
    mirror: { label: "hf-mirror.com（直连）", hosts: ["https://hf-mirror.com/"] },
  };
}

// ONNX file names Transformers.js resolves for each precision.
const ONNX_FILE = {
  fp32: "onnx/model.onnx",
  fp16: "onnx/model_fp16.onnx",
  q8: "onnx/model_quantized.onnx",
  int8: "onnx/model_int8.onnx",
  uint8: "onnx/model_uint8.onnx",
  q4: "onnx/model_q4.onnx",
};

export function webgpuAvailable() {
  return typeof navigator !== "undefined" && Boolean(navigator.gpu);
}

/**
 * Whether a WebGPU adapter can actually be obtained.
 * `navigator.gpu` exists in browsers that still cannot provide an adapter (headless
 * Chrome without a GPU, blocked drivers), so the feature has to be probed for real.
 */
export async function requestWebgpuAdapter() {
  if (!webgpuAvailable()) return null;
  try {
    return (await navigator.gpu.requestAdapter()) ?? null;
  } catch {
    return null;
  }
}

/** URL of a model file on a given host. */
export function modelFileUrl(host, model, dtype) {
  const file = ONNX_FILE[dtype];
  if (!file) return null;
  return `${host}${model}/resolve/main/${file}`;
}

/** Real on-disk size of the chosen ONNX weight file (bytes), or null if unavailable. */
export async function modelFileSize(model, dtype, host = MODEL_HOSTS[0]) {
  const url = modelFileUrl(host, model, dtype);
  if (!url) return null;
  try {
    const response = await fetch(url, { method: "HEAD" });
    if (!response.ok) return null;
    const length = response.headers.get("content-length") ?? response.headers.get("x-linked-size");
    return length ? Number(length) : null;
  } catch {
    return null;
  }
}

/** Probe budget per host: the local proxy may need to resolve its upstream first. */
function timeoutFor(host) {
  if (typeof location !== "undefined" && host.startsWith(location.origin)) return 30_000;
  return 12_000;
}

/**
 * Find the first host that really serves the model's config file.
 *
 * The probe uses GET on purpose: `hf-mirror.com` answers a HEAD request with CORS
 * headers but its redirect target sends none for GET, so a HEAD probe reports a host
 * as usable while the actual model download is blocked by the browser.
 *
 * Returns the chosen host plus the per-host probe results (for the UI).
 */
export async function resolveModelHost(model, hosts = MODEL_HOSTS, timeoutMs = null) {
  const probes = [];
  for (const host of hosts) {
    const url = `${host}${model}/resolve/main/config.json`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? timeoutFor(host));
    try {
      const response = await fetch(url, { signal: controller.signal });
      const ok = response.ok;
      if (ok) {
        // Consume the body so the probe exercises the same path as a real download.
        await response.arrayBuffer().catch(() => {});
      }
      probes.push({ host, ok, status: response.status });
      if (ok) return { host, probes };
    } catch (error) {
      probes.push({ host, ok: false, status: null, error: String(error?.message ?? error) });
    } finally {
      clearTimeout(timer);
    }
  }
  // Nothing answered: keep the first host so the real download error surfaces.
  return { host: hosts[0] ?? MODEL_HOSTS[0], probes, reachable: false };
}

export class Embedder {
  constructor() {
    this.extractor = null;
    this.model = null;
    this.dtype = null;
    this.device = null;
    this.fallbackReason = null;
    this.remoteHost = null;
    this.hostProbes = [];
    this.loadMs = null;
  }

  get ready() {
    return this.extractor !== null;
  }

  get dimension() {
    return MODELS[this.model]?.dimension ?? 384;
  }

  async load({ model, dtype, device = "auto", source = "auto" }) {
    const started = performance.now();
    this.fallbackReason = null;
    this.hostProbes = [];

    const sources = modelSources();
    const hosts = sources[source]?.hosts ?? sources.auto.hosts;

    // Pick the execution backend. In `auto` mode WebGPU is used only when an adapter
    // can really be obtained: browsers expose `navigator.gpu` even when no adapter is
    // available (headless, blocked drivers), and the WebGPU kernel set does not cover
    // the INT8 weights.
    let primary;
    if (device === "webgpu") {
      primary = "webgpu";
    } else if (device === "auto") {
      const adapter = await requestWebgpuAdapter();
      primary = adapter ? "webgpu" : "wasm";
      if (!adapter) this.fallbackReason = "WebGPU 无可用适配器，已自动降级到 WASM";
    } else {
      primary = "wasm";
    }
    // WebGPU does not provide the q8 kernel; keep the request honest and let a
    // q8 + WebGPU selection land on fp16 there.
    const effectiveDtype = primary === "webgpu" && dtype === "q8" ? "fp16" : dtype;

    // Try every candidate host until one actually loads the model: a host can pass a
    // config probe and still fail on the (much larger) weight download.
    const failures = [];
    for (const host of hosts) {
      env.remoteHost = host;
      const probe = await resolveModelHost(model, [host]);
      this.hostProbes.push(...(probe.probes ?? []));
      if (!probe.reachable && probe.probes?.some((p) => !p.ok)) {
        failures.push(`${host}: ${probe.probes[0]?.error ?? `HTTP ${probe.probes[0]?.status}`}`);
        continue;
      }

      try {
        this.extractor = await this.buildPipeline(model, dtype, effectiveDtype, primary);
        this.device = primary;
        this.remoteHost = host;
        this.model = model;
        this.dtype = this.device === "webgpu" ? effectiveDtype : dtype;
        this.loadMs = performance.now() - started;
        return this.describe();
      } catch (error) {
        if (primary === "webgpu") {
          // WebGPU itself failed (no adapter, driver bug, …) — degrade to WASM.
          this.fallbackReason = `WebGPU 不可用，已自动降级到 WASM：${String(error?.message ?? error)}`;
          try {
            this.extractor = await this.buildPipeline(model, dtype, dtype, "wasm");
            this.device = "wasm";
          } catch (wasmError) {
            failures.push(`${host} (WASM): ${String(wasmError?.message ?? wasmError)}`);
            this.extractor = null;
            continue;
          }
        } else {
          failures.push(`${host}: ${String(error?.message ?? error)}`);
          this.extractor = null;
          continue;
        }
        this.remoteHost = host;
        this.model = model;
        this.dtype = dtype;
        this.loadMs = performance.now() - started;
        return this.describe();
      }
    }

    throw new Error(`所有模型源都不可用：${failures.join(" | ") || "没有候选源"}`);
  }

  buildPipeline(model, dtype, effectiveDtype, dev) {
    return pipeline("feature-extraction", model, {
      dtype: dev === "webgpu" ? effectiveDtype : dtype,
      device: dev,
    });
  }

  describe() {
    return {
      model: this.model,
      dimension: this.dimension,
      dtype: this.dtype,
      device: this.device,
      loadMs: this.loadMs,
      fallbackReason: this.fallbackReason,
      remoteHost: this.remoteHost,
      hostProbes: this.hostProbes,
    };
  }

  /** Mean-pooled, L2-normalized sentence vectors. */
  async embed(texts) {
    if (!this.extractor) throw new Error("model is not loaded yet");
    const input = Array.isArray(texts) ? texts : [texts];
    const output = await this.extractor(input, { pooling: "mean", normalize: true });
    return output.tolist();
  }

  /** Embed many texts in bounded batches so the UI can show progress. */
  async embedBatched(texts, batchSize = 8, onProgress) {
    const vectors = [];
    for (let start = 0; start < texts.length; start += batchSize) {
      const batch = texts.slice(start, start + batchSize);
      const embedded = await this.embed(batch);
      vectors.push(...embedded);
      onProgress?.(Math.min(start + batch.length, texts.length), texts.length);
      // Yield to the event loop so progress paints between batches.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return vectors;
  }
}
