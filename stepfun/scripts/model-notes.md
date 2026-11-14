# 模型获取与量化说明

本应用不在服务端做 embedding；浏览器用 **Transformers.js** 加载公开的 ONNX embedding 模型并在本机推理。模型权重的“精度选择”即量化方案。

## 1. 模型与来源

| 模型 | 维度 | 来源 | 备注 |
| --- | --- | --- | --- |
| `Xenova/all-MiniLM-L6-v2` | 384 | https://huggingface.co/Xenova/all-MiniLM-L6-v2 | 默认；轻量、通用 |
| `Xenova/bge-small-en-v1.5` | 384 | https://huggingface.co/Xenova/bge-small-en-v1.5 | 英文检索效果较好 |

两者均为 384 维，与后端 `EMBEDDING_DIMENSION=384` 和 seekdb 集合的 `VectorIndexConfig({ hnsw: { dimension: 384, distance: "cosine" } })` 一致。切换模型时维度不变，无需重建集合。

## 2. 精度 / 量化方案

Transformers.js 依据 `dtype` 解析对应的 ONNX 权重文件：

| `dtype` | ONNX 文件 | 方案 | 相对 fp32 体积 |
| --- | --- | --- | --- |
| `fp32` | `onnx/model.onnx` | 32 位浮点（基线） | 1× |
| `fp16` | `onnx/model_fp16.onnx` | 半精度（16 位） | ≈ 0.5× |
| `q8`（INT8） | `onnx/model_quantized.onnx` | 8 位整数量化 | ≈ 0.25× |

**实测真实字节数**（HTTP `HEAD`，界面自动显示）：

| 模型 | fp32 | fp16 | INT8(q8) | fp32/INT8 |
| --- | --- | --- | --- | --- |
| `Xenova/all-MiniLM-L6-v2` | 90,387,606 B（86.2 MiB） | 45,297,825 B（43.2 MiB） | 22,972,370 B（21.9 MiB） | **3.94×** |
| `Xenova/bge-small-en-v1.5` | 133,093,490 B（126.9 MiB） | 66,749,212 B（63.7 MiB） | 34,014,426 B（32.4 MiB） | **3.91×** |

- 量化在权重层面完成（使用模型仓库提供的 FP16 / INT8 权重），**不改动对外语义**：输出仍是 384 维向量，检索流程不变。
- 代码在 `web/src/embedder.js` 中按 `dtype` 选择文件；应用加载前后各做一次 HTTP `HEAD`，读取 `content-length` 得到真实体积并计算压缩比（`fp32 / INT8`），显示在「1 · 端侧模型」区域。
- WebGPU 不提供 q8 内核：当“精度=INT8”且命中 WebGPU 时，实际退化为 `fp16`（界面与状态栏会显示真实生效的精度）。WASM 后端使用所选的 `q8`/`fp32`。
- `device=auto` 会**真正申请一次 WebGPU 适配器**再决定后端（`navigator.gpu` 存在不等于能拿到适配器），拿不到则自动用 WASM 并显示降级原因。

## 3. 权重下载：默认走后端同源代理

浏览器直连模型仓库在真实网络里经常不可用，本项目实测：

| 源 | Node（curl / fetch） | 浏览器 |
| --- | --- | --- |
| `huggingface.co` | 连接超时（约 10.7 s） | `ERR_CONNECTION_TIMED_OUT` |
| `hf-mirror.com` | 正常（1.4–2.7 s） | 307 重定向目标 `/api/resolve-cache/...` 对 `GET` 不带 `Access-Control-Allow-Origin` → CORS 拦截 |

因此后端提供同源代理 `GET|HEAD /model/<repo>/resolve/<rev>/<file>`（`server/src/models.mjs`）：

- **只转发权重字节，不做任何推理**——推理始终在用户设备上。
- 上游**竞速**：多个镜像并行尝试（单次 8 s 超时），最快应答者胜出并被记住（粘滞），避免不可达的源每次都拖慢请求。
- 超时只覆盖**响应头**：权重本身约 60 s 传完；若用同一超时中断响应体，浏览器会报 `ERR_CONTENT_LENGTH_MISMATCH`。
- 代理把权重缓存到 `stepfun/.cache/models/`，二次启动免下载（模型加载 182.3 s → 8.9 s）。
- 界面仍可手动切到直连源；探测一律用 `GET`（镜像对 `HEAD` 回 CORS 头、对 `GET` 不回，用 `HEAD` 探测会得到「可用」的假象）。

可覆盖上游列表：`MODEL_UPSTREAM_HOSTS="https://hf-mirror.com/,https://huggingface.co/"`。

## 4. 浏览器缓存

首次使用某个「模型 + dtype」时会下载对应权重，随后由浏览器 HTTP 缓存与 Transformers.js 本地缓存复用；后端代理另有自己的磁盘缓存。无需手工步骤。

## 5. 离线预缓存（可选）

若运行环境完全不能联网，可预先把权重放到本地并让 Transformers.js 走本地目录：

1. 下载所需文件到一个目录，例如 `web/vendor/Xenova/all-MiniLM-L6-v2/`：

   ```
   config.json
   tokenizer.json
   tokenizer_config.json
   onnx/model.onnx          # fp32（基线）
   onnx/model_fp16.onnx     # fp16（可选）
   onnx/model_quantized.onnx# INT8（可选）
   ```

   对应 URL 形如
   `https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/onnx/model_quantized.onnx`。

2. 在 `web/src/embedder.js` 顶部按需设置（示例）：

   ```js
   import { env } from "@huggingface/transformers";
   env.allowRemoteModels = false;
   env.allowLocalModels = true;
   env.localModelPath = "/vendor/"; // 相对站点根目录
   ```

   之后把模型选择框的取值当作本地相对路径使用（如 `Xenova/all-MiniLM-L6-v2` 对应 `web/vendor/Xenova/all-MiniLM-L6-v2/`）。

3. 该模式下体积测量仍可用：`modelFileSize()` 读取的远端 `HEAD` 若不可达会返回“未知”，可在离线部署时改为读取本地文件大小。

## 6. 复现与记录

- 记录项：模型名与版本、`dtype`、推理后端（WebGPU/WASM）、批大小、seekdb 版本与集合索引配置。
- 质量对比：用 `data/eval.json` 在同一语料、同一查询集上计算 Recall@K / nDCG@K，比较量化前后变化。
- 性能对比：分别报告“冷（首次加载/首次请求）”与“热（预热后）”，多测取中位数；本应用在「性能观测」表格中分阶段记录，避免只取最快一次。
