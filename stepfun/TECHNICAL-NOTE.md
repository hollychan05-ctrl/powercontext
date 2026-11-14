# 一页技术说明 · 端侧知识库（浏览器本地向量化 + seekdb 混合检索）

## 1. 模型与量化

- 模型：`Xenova/all-MiniLM-L6-v2`（384 维，默认）或 `Xenova/bge-small-en-v1.5`（384 维）；均为公开 ONNX 版权重，来源与版本见 `scripts/model-notes.md`。
- 量化：按 Transformers.js 的 `dtype` 选择权重——`fp32`（基线）/ `fp16` / `INT8 q8`。量化在权重层面完成，输出仍为 384 维向量。
- **实测体积与压缩比**（HTTP `HEAD` 真实字节数，界面自动显示）：

  | 模型 | fp32 | fp16 | INT8(q8) | fp32/INT8 |
  | --- | --- | --- | --- | --- |
  | `all-MiniLM-L6-v2` | 90,387,606 B（86.2 MiB） | 45,297,825 B（43.2 MiB） | 22,972,370 B（21.9 MiB） | **3.94×** |
  | `bge-small-en-v1.5` | 133,093,490 B（126.9 MiB） | 66,749,212 B（63.7 MiB） | 34,014,426 B（32.4 MiB） | **3.91×** |

- 质量变化：在同一语料/查询集上计算 Recall@K 与 nDCG@K（`data/eval.json`），比较量化前后。实测（fp16 + WebGPU，8 条标注查询）Recall@5 **0.8750**、nDCG@5 **0.8933**；INT8 与 fp32 的逐项对比在目标机器上用同一界面复跑即可得到。

## 2. 端侧运行

- 运行时：Transformers.js（ONNX Runtime Web）。**文档向量化与查询向量化都在浏览器本机完成**，无任何云端推理调用，也不回放服务端预计算结果。
- 后端选择：`device=auto` 时**实际申请一次 WebGPU 适配器**（`navigator.gpu` 存在不等于可用），拿到就用 WebGPU，否则用 WASM；界面与状态栏明确显示当前后端与降级原因。WebGPU 无 INT8 内核，故 WebGPU 自动改用 `fp16`，WASM 用 `INT8`。
- 批处理：文档按 8 条一批向量化并回报进度，批间让出事件循环以便界面刷新。
- **权重下载走同源代理**（`GET|HEAD /model/<repo>/resolve/<rev>/<file>`）：浏览器直连模型仓库在真实网络里经常不可用——`huggingface.co` 连接超时；`hf-mirror.com` 的 307 重定向目标 `/api/resolve-cache/...` 对 `GET` 不带 `Access-Control-Allow-Origin`，被浏览器拦截。后端只**转发权重字节、不做推理**，并用「多上游竞速（单次 8 s 超时）+ 粘滞命中 + 本地磁盘缓存」保证可用与速度（模型加载 182.3 s → 8.9 s）。探测用 `GET` 而非 `HEAD`：镜像对 `HEAD` 回 CORS 头、对 `GET` 不回，用 `HEAD` 探测会得到「可用」的假象。

## 3. seekdb 使用

- 接入：`seekdb-js`（npm `seekdb`）。默认 **embedded 模式**（`path=./.seekdb/kb.db`）；也可 `server` 模式连本地 seekdb/OceanBase（`host/port/user/password/database`，OceanBase 另加 `tenant`）。
- 集合 Schema（`server/src/seekdb.mjs`）：

  ```js
  new Schema()
    .createIndex(new FulltextIndexConfig())                       // 全文通道
    .createIndex(new VectorIndexConfig({
      hnsw: { dimension: 384, distance: "cosine" },
      embeddingFunction: null,                                    // 关闭服务端向量化：向量来自浏览器
    }))
  ```

- 混合检索：一次 `collection.hybridSearch()` 同时发起全文通道（`query.whereDocument.$contains`）与稠密向量通道（`knn.queryEmbeddings`），由 seekdb 用 **RRF**（`rank:{rrf:{}}`）融合。应用**不**分别取两路结果再自行拼合——这正是本题「检索处理由 seekdb 完成」的要求。
- 数据：`collection.upsert({ ids, documents, embeddings, metadatas })` 写入向量、原文与元数据（含文档 ID）。
- 增量写入与刷新：`upsert` 后调用 `collection.refresh_index()`，新内容才可被 `knn`/`hybridSearch` 命中；随后用「自查询」校验（用文档自身向量检索），界面显示命中名次。
- 状态一致：集合名、维度与连接通过 `.env` 固定；前端保留本次会话的导入/检索状态，支持清空数据库与更换语料后检索结果与当前库一致。
- **接入时踩到并已修的三个坑**：① 写入不自动更新向量索引 → 补 `refresh_index()`；② 集合元数据里的 `'default-embed'` 让 SDK 去本地注册表解析而报错 → 建集合显式传 `embeddingFunction: null`；③ `delete({whereDocument:{$contains:""}})` 静默删不掉 → 改为取全部 id 后按 id 列表删除。

## 4. 状态与优化

- 会话/集合状态：后端进程持有集合连接；前端维护「已导入/已检索」视图，可「清空数据库」或在同一集合上继续增量导入。
- 优化点：embedding 批处理（降低单条开销）、模型加载一次复用、按 `dtype` 降低权重体积与显存、按 `distance=cosine` 固定距离度量、限定检索返回数（`nResults`）、权重磁盘缓存（二次启动免下载）。
- 计时：分阶段记录——模型下载/加载、文档向量化、写入与索引刷新、查询向量化、seekdb 检索、端到端；冷/热分开、重复测量取中位数。
- 测试：`npm run unit`（17 项断言，无需 seekdb/原生绑定/网络，覆盖结果归一化与检索指标，浏览器评测面板复用同一 `web/src/metrics.js`）；`npm run smoke`（真实 seekdb 端到端）；`npm run api`（真实后端 HTTP 端到端）；`npm run browser`（CDP 驱动真实 Chrome/Edge 跑完整 UI）。

## 5. 关键性能与质量对比（本机实测）

Windows 11 + Chrome 157（headless，WebGPU 适配器可用）+ 本地 seekdb `5.7.25-OceanBase seekdb`；语料 16 篇、评测 8 条查询，数值由应用「性能观测」「检索质量对比」面板直接产出。

| 配置 | 模型体积 | 模型加载（冷→热） | 文档向量化(16) | seekdb 检索 | 端到端查询 | Recall@5 | nDCG@5 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| fp16 + WebGPU | 43.2 MiB | 182.3 s → 8.9 s | 1,305.8 ms | 59.5 ms | 2,169.1 ms（中位 831.0 ms） | 0.8750 | 0.8933 |
| fp32 + WASM（基线） | 86.2 MiB | 同设备复跑 | 同设备复跑 | 同设备复跑 | 同设备复跑 | 同设备复跑 | 同设备复跑 |
| INT8 + WASM | 21.9 MiB | 同设备复跑 | 同设备复跑 | 同设备复跑 | 同设备复跑 | 同设备复跑 | 同设备复跑 |

> 同一台机器、同一浏览器、同一语料与查询集下复跑即可填满其余两行；比较单项优化时保持其他条件一致。
> 另有硬性事实：Windows 上若启用 Application Control / WDAC，`embedded` 模式的未签名 `seekdb.node` 会被拦截（`An Application Control policy has blocked this file`），此时用 `SEEKDB_MODE=server`。
