# 端侧知识库 · 浏览器本地向量化 + seekdb 混合检索

一个迷你知识库 Web 应用：**文档与查询的 embedding 全部在浏览器本机计算**（Transformers.js，优先 WebGPU、自动降级 WASM），向量与原文写入 **seekdb**，检索由 **seekdb 的混合检索**（全文 + 稠密向量，RRF 融合）完成。不调用任何云端推理 API。

> 对应赛题：seekdb × 阶跃星辰「端侧 AI 推理性能优化与 seekdb 混合检索」。

## 架构

```
┌────────────────────────── 浏览器（用户设备） ──────────────────────────┐
│  index.html / src/main.js                                              │
│    ├─ src/embedder.js  Transformers.js：ONNX embedding（WebGPU→WASM）  │
│    └─ src/api.js       POST /api/ingest, /api/search, /api/verify …    │
└───────────────────────────────┬───────────────────────────────────────┘
                                 │  只传「文本 + 向量」（不含推理）
┌───────────────────────────────▼───────────────────────────────────────┐
│  本地后端 server/src/index.mjs（Node ≥20，同源托管 web/）              │
│    └─ src/seekdb.mjs   seekdb-js：集合(fulltext + HNSW vector)         │
│           collection.add({documents, embeddings})                     │
│           collection.hybridSearch({ query:{whereDocument}, knn:{queryEmbeddings}, rank:{rrf} }) │
└───────────────────────────────┬───────────────────────────────────────┘
                                 ▼
                    seekdb（embedded 本地文件 / 本地 server）
```

混合检索在 seekdb 内完成：本应用**不会**分别取全文与向量结果再到应用层拼合。

## 目录结构

```
stepfun/
├─ package.json            # 便捷脚本（安装/启动/四项测试）
├─ .env.example            # 连接与端口占位配置（不含真实凭据）
├─ server/                 # 本地后端（Node）
│  ├─ package.json         # 依赖：seekdb
│  ├─ src/config.mjs       # 环境变量解析
│  ├─ src/seekdb.mjs       # seekdb-js 封装（集合、写入、混合检索、校验）
│  ├─ src/models.mjs       # 同源模型权重代理（竞速上游 + 本地缓存）
│  ├─ src/rows.mjs         # 结果归一化的纯函数（可单测）
│  ├─ src/index.mjs        # HTTP + 静态托管
│  └─ test/
│     ├─ unit.mjs          # 纯逻辑单元测试（17 项断言，无需网络/数据库）
│     ├─ smoke.mjs         # seekdb 端到端（写入→混合检索→刷新校验→清空）
│     ├─ api.mjs           # HTTP API 端到端
│     └─ browser.mjs       # CDP 驱动真实浏览器的 UI 端到端
├─ web/                    # 浏览器应用（无需打包器）
│  ├─ index.html
│  ├─ styles.css
│  └─ src/{main.js, embedder.js, api.js, metrics.js}
├─ data/
│  ├─ corpus.jsonl         # 可复现示例语料（16 条）
│  └─ eval.json            # 标注评测集（8 条查询）
├─ .cache/models/          # 代理下载的权重缓存（自动生成，已 gitignore）
└─ scripts/model-notes.md  # 模型获取与量化说明
```

## 前置条件

- **Node.js ≥ 20**（`seekdb` 的 embedded 原生绑定支持 `win32-x64` / `linux-x64` / `linux-arm64` / `darwin-arm64`）。
- **Chrome 或 Edge 最新版**（WebGPU 可选；不支持时自动用 WASM）。
- 首次加载模型需要能下载 ONNX 权重：后端自带**同源模型代理** `/model/...`，会自动在可用镜像之间择优，不需要手动配置（详见「模型获取与量化」）。

## 安装与启动

```bash
# 1) 安装后端依赖
npm --prefix server install        # 或 cd server && npm install

# 2)（可选）配置连接
cp .env.example .env               # Windows: copy .env.example .env

# 3) 启动后端（同时托管前端）
npm start                          # 或 node server/src/index.mjs

# 4) 浏览器打开
#    http://127.0.0.1:8787/
```

### seekdb 两种模式

| 模式 | 配置 | 说明 |
| --- | --- | --- |
| `embedded`（默认） | `SEEKDB_MODE=embedded`，`SEEKDB_PATH=./.seekdb/kb.db` | 本进程直接持有本地数据库目录，零外部服务 |
| `server` | `SEEKDB_MODE=server`，`SEEKDB_HOST/PORT/USER/PASSWORD/DATABASE` | 连接已有 seekdb / OceanBase（OceanBase 另加 `SEEKDB_TENANT`） |

### 测试

**1）纯逻辑单元测试**（不需要 seekdb、不需要原生绑定、不需要网络）：

```bash
npm run unit        # 或 node server/test/unit.mjs
```

覆盖两处非平凡逻辑：seekdb 结果归一化（`rows`/`toHits`/`validateVectors`，兼容 query/hybridSearch 的嵌套结构与 get 的扁平结构）与检索指标（`web/src/metrics.js` 的 Recall@K / nDCG@K，与浏览器评测面板共用同一模块）。

**2）后端冒烟测试**（需要可用的 seekdb，验证「写入 → 混合检索 → 向量检索 → 刷新校验 → 清空」）：

```bash
npm run smoke       # 或 node server/test/smoke.mjs
```

**3）HTTP API 端到端测试**（启动真实后端，用 HTTP 驱动全部接口）：

```bash
npm run api         # 或 node server/test/api.mjs
```

**4）浏览器端到端测试**（CDP 驱动真实 Chrome/Edge，跑完整 UI 流程）：

```bash
npm run browser     # 或 node server/test/browser.mjs
```

四项测试的实际运行结果见 [「验证记录」](#验证记录)。

冒烟测试走真实 seekdb：`embedded` 模式会在首次使用时下载约 91 MB 的原生绑定（`~/.seekdb/bindings/…`）；若不想下载，可设 `SEEKDB_MODE=server` 连到已有的 seekdb/OceanBase。

> **Windows 注意**：`embedded` 模式加载的 `seekdb.node` 是未签名的原生插件，若本机启用了 **Application Control / WDAC（智慧型應用程式控制）**，加载会失败并报
> `An error occurred while loading the native addon … An Application Control policy has blocked this file`。
> 此时请改用 `SEEKDB_MODE=server` 连本地/远端 seekdb，或在未启用该策略的机器上运行。纯逻辑单元测试不受影响，仍可全绿。

## 使用步骤

1. **加载模型**：选择模型（默认 `Xenova/all-MiniLM-L6-v2`）与精度（`fp32` 基线 / `fp16` / `INT8`）；点「加载模型」。状态栏显示实际推理后端（WebGPU / WASM）与模型体积/压缩比。
2. **导入语料**：点「载入示例语料」（读取 `data/corpus.jsonl`），或粘贴/选择自己的文本；点「向量化并写入」。文档向量化在浏览器完成，随后写入 seekdb；写入后会自动做一次「刷新后仍可检索」的校验。
3. **检索**：输入查询，选择「混合（seekdb RRF）」或「仅向量」，查看排序结果、`distance` 与原文。
4. **质量对比**：点「运行评测」，用 `data/eval.json` 计算当前配置的 Recall@K / nDCG@K；先加载 `fp32` 跑一次，再加载 `INT8`/`fp16` 跑一次，表格即可对比量化前后的检索质量。
5. **性能观测**：底部表格分别记录冷/热阶段的模型加载、文档向量化、写入、查询向量化、seekdb 检索与端到端延迟。

## 模型获取与量化

见 [`scripts/model-notes.md`](scripts/model-notes.md)。要点：

- 通过 Transformers.js 的 `dtype` 选择 **fp32 / fp16 / INT8(q8)** 三套 ONNX 权重，均从 Hugging Face 公开仓库获取（`onnx/model.onnx`、`model_fp16.onnx`、`model_quantized.onnx`）。
- 应用用 HTTP `HEAD` 读取所选权重的真实字节数，直接给出**体积与压缩比**（`fp32/INT8`）。
- 量化方式：采用权重层面的 FP16 / INT8 方案（来自官方仓库的量化权重），不改动对外语义。
- 离线运行：可选地把权重预下载到本地并让 Transformers.js 走本地目录（见笔记）。

### 实测体积（HTTP `HEAD` 真实字节数）

| 模型 | fp32 | fp16 | INT8(q8) | fp32/INT8 |
| --- | --- | --- | --- | --- |
| `Xenova/all-MiniLM-L6-v2` | 90,387,606 B（86.2 MiB） | 45,297,825 B（43.2 MiB） | 22,972,370 B（21.9 MiB） | **3.94×** |
| `Xenova/bge-small-en-v1.5` | 133,093,490 B（126.9 MiB） | 66,749,212 B（63.7 MiB） | 34,014,426 B（32.4 MiB） | **3.91×** |

### 为什么走「本地后端代理」下载权重

浏览器**直连模型仓库在真实网络里经常不可用**，本项目实测到三种情况：

| 源 | Node（curl / fetch） | 浏览器 |
| --- | --- | --- |
| `huggingface.co` | 连接超时（约 10.7 s） | `ERR_CONNECTION_TIMED_OUT` |
| `hf-mirror.com` | 正常（1.4–2.7 s） | 307 的重定向目标 `/api/resolve-cache/...` **不带 `Access-Control-Allow-Origin`**，GET 被 CORS 拦截 |

因此后端提供同源代理 `GET|HEAD /model/<repo>/resolve/<rev>/<file>`（`server/src/models.mjs`）：

- **只转发权重字节，不做任何推理**——推理始终在用户设备上完成。
- 上游用**竞速 + 粘滞**：多个镜像并行尝试（单次 8 s 超时），最快应答者胜出并被记住，避免不可达的源每次都拖慢请求。
- 超时只覆盖**响应头**：权重本身约 60 s 传完，若用同一个超时中断响应体会造成 `ERR_CONTENT_LENGTH_MISMATCH`。
- 代理会把权重缓存到 `stepfun/.cache/models/`，第二次启动秒开（模型加载 182.3 s → 8.9 s）。
- 界面仍可手动选择直连源；探测用 **GET**（不是 HEAD）——镜像对 `HEAD` 回 CORS 头、对 `GET` 不回，用 HEAD 探测会得到「可用」的假象。

## 验证记录

在 Windows 11 + Chrome 157（headless，WebGPU 适配器可用）+ 本地 seekdb `5.7.25-OceanBase seekdb`（端口 2882）上实测：

| 测试 | 命令 | 结果 |
| --- | --- | --- |
| 纯逻辑单元测试 | `npm run unit` | ✅ 17/17 断言通过 |
| seekdb 端到端 | `npm run smoke` | ✅ 写入 3 → 向量 top3 → RRF 混合序 `beta, alpha, gamma` → 新写入文档刷新后命中第 1 位 → 清空 |
| HTTP API 端到端 | `npm run api` | ✅ health / ingest / stats / hybrid / verify / vector-only / 维度校验 / 静态托管 |
| 浏览器端到端 | `npm run browser` | ✅ 浏览器内 WebGPU 加载模型 → 16 篇入库 → 混合检索首位命中 `hybrid-search` → 评测 Recall@5 **0.8750**、nDCG@5 **0.8933** |

浏览器端到端实测数据（应用内「性能观测」面板产出）：

| 阶段 | 冷启动 | 热启动（权重已缓存） |
| --- | --- | --- |
| 模型加载 | 182,342.6 ms | 8,861.5 ms |
| 文档向量化（16 篇） | 1,373.6 ms | 1,305.8 ms |
| 写入 seekdb（upsert + 索引刷新） | 1,008.5 ms | 801.0 ms |
| 查询向量化 | 825.0 ms | 770.3 ms |
| seekdb 混合检索 | 96.1 ms | 59.5 ms |
| 端到端（提交→结果） | 2,409.1 ms | 2,169.1 ms（中位 831.0 ms） |

> 检索质量（Recall@5 0.8750 / nDCG@5 0.8933，8 条标注查询）由浏览器内评测面板产出，与 `web/src/metrics.js` 单元测试共用同一实现。INT8 与 fp32 的逐项对比在目标机器上用同一界面复跑即可得到。

## seekdb 接入中实测到的三个坑（已修）

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 新写入的文档查不到 | 向量索引不随写入自动更新 | `upsert` 之后调用 `collection.refresh_index()` |
| `Embedding function 'default-embed' is not registered.` | 集合元数据里记着服务端 embedding 函数，SDK 会去本地注册表解析 | 建集合时显式传 `embeddingFunction: null`（服务端本来就不做向量化） |
| `delete({whereDocument: {$contains: ""}})` 删不掉数据 | 条件静默匹配不到任何行 | 清空改为先取全部 id 再按 id 列表删除 |

## 验证样例

- **初始条件**：全新数据库；已加载 `Xenova/all-MiniLM-L6-v2`（`fp32` 或 `INT8`）。
- **输入**：点「载入示例语料」→「向量化并写入」；查询 `How does hybrid search combine keyword and vector results?`，模式「混合」。
- **预期**：结果包含 `hybrid-search` 与 `rrf` 两条文档；`distance` 为余弦距离；“刷新后 … 命中”提示出现。
- **量化对比**：分别用 `fp32` 与 `INT8` 运行评测，表格两行给出 Recall@K / nDCG@K。

## 已知限制

- 首次加载需联网下载 ONNX 权重（经后端代理，权重缓存到 `.cache/models/`）；完全离线部署需自行预置该目录（见笔记）。
- WebGPU 的可用性与浏览器/驱动相关：`auto` 模式会真正申请一次适配器，拿不到就自动降级 WASM 并显示原因；WebGPU 无 INT8 内核，故 WebGPU 走 `fp16`、WASM 走 `INT8`。
- 本机若启用了 Application Control / WDAC，`embedded` 模式的原生插件会被拦截，需改用 `SEEKDB_MODE=server`。
- 后端为本地单进程，适合个人/小规模知识库；未做鉴权，请勿直接暴露到公网。
- 示例语料与评测集为演示用途，规模较小。

## 安全

- 不提交任何真实凭据；`.env` 已被忽略，配置示例使用占位值。
- 推理不出本机；后端仅在本机回环地址使用。
