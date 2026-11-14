# 迷宮酒館 · Dify × OceanBase seekdb 互動文字冒險

> 對應賽題：AI 生態賽 · Dify 題「Just for Fun：用 Dify 做一個好玩的智能應用」。

一個由 **Dify Chatflow** 驅動的文字冒險遊戲：你是走進迷宮第七層邊緣、唯一還開著的酒館「醉月」的冒險者，Dify 裡的 LLM 節點擔任地下城主（DM），**每一回合的狀態、記憶與規則卡都落在 OceanBase seekdb**。

```
┌──────────────────────── Dify（流程編排） ─────────────────────────┐
│                                                                      │
│  start ─► get_context ─► retrieve_rules ─► dm ─► parse_state ─► save_state ─► answer │
│            (HTTP GET)     (知識庫檢索)     (LLM)   (Code 節點)   (HTTP POST)          │
│              │                │                │          │           │                  │
└──────────────┼────────────────┼────────────────┼──────────┼───────────┼──────────────────┘
               │                │                │          │           │
               ▼                ▼                ▼          │           │
      ┌──────────────────────────────────┐          │           │
      │ session-state 服務 (Node)         │          │           │
      │  GET  /api/context  → 回合簡報    │──────────┘           │
      │  POST /api/state    → 寫回狀態    │──────────────────────┘
      └──────────────┬───────────────────┘
                     ▼
   ┌──────────── OceanBase seekdb ────────────┐
   │  Dify 向量庫：迷宮酒館規則庫（11 張卡）     │
   │  maze_tavern_state ：每個對話一列狀態       │
   │  maze_tavern_memory：每回合一列記憶日誌     │
   │  （全文 + HNSW 向量索引，RRF 混合檢索）    │
   └───────────────────────────────────────────┘
```

## 這個題目的設計重點

1. **Dify 承擔核心編排**：所有回合流程都在 DSL 裡（7 個節點），可匯出、可匯入、可在 Dify 畫布上直接改。
2. **seekdb 同時扮演三個角色**：Dify 部署的向量庫（規則知識庫）、應用的狀態庫、應用的記憶庫。三者都在同一個 seekdb 實例裡。
3. **seekdb 就是記憶層**：Dify 內建的對話記憶被**刻意移除**（DSL 裡完全沒有 `memory:` 欄位）。Dify 的記憶存的是「最終回答」，回答裡帶著系統產生的狀態面板，DM 看到前一輪的面板就會照抄格式、忘記輸出狀態區塊——狀態會卡在第 2 回合。改由 seekdb 持有記憶後，DM 每輪看到的都是乾淨的回合簡報，格式漂移消失。
4. **服務端組裝上下文**：`GET /api/context` 直接回傳 `text/plain` 的回合簡報（狀態行 + 近期紀錄 + 混合檢索結果 + 玩家輸入）。Dify 的 Code 節點沙箱沒有 `json` 模組，純文字讓整條鏈路不必在沙箱裡手寫 JSON parser。

## 目錄結構

```
dify/
├─ dsl/
│  ├─ maze-tavern.template.yml   # 手寫的 Chatflow 模板（__MAZE_DATASET_ID__ 佔位）
│  └─ maze-tavern.yml            # 交付的 DSL（Dify 自己匯出的版本，可直接匯入）
├─ data/kb/                      # 知識庫原始碼：11 張規則卡（markdown）
├─ service/                      # session-state 服務（Node ≥ 20，seekdb-js）
│  ├─ src/config.mjs             # 環境變數
│  ├─ src/seekdb.mjs             # 集合定義、fulltext + HNSW、RRF 混合檢索
│  ├─ src/state.mjs              # 狀態合併 / 欄位淨化 / 文件化
│  ├─ src/context.mjs            # 回合簡報組裝（純文字）
│  ├─ src/embeddings.mjs         # embedding 客戶端（含快取）
│  ├─ src/world.mjs              # 靜態世界觀種子
│  ├─ src/server.mjs             # HTTP API
│  ├─ scripts/seed.mjs           # 種子資料（demo-session）
│  ├─ scripts/smoke.mjs          # 服務端 7 段端到端冒煙測試
│  └─ .env.example               # 連線設定範本（不含真實憑據）
├─ scripts/                      # Dify 側的準備、匯入與驗證腳本
│  ├─ setup-admin.mjs            # 首次初始化管理員
│  ├─ setup-model.mjs            # 安裝模型外掛 + 設定 NVIDIA NIM 模型
│  ├─ seed-kb.mjs                # 建立知識庫並匯入 11 張規則卡
│  ├─ build-dsl.mjs              # 模板 → 可匯入 DSL（代換 dataset id）
│  ├─ import-dsl.mjs             # 匯入 DSL，再從 Dify 匯出回來
│  ├─ check-dsl.mjs              # 對匯出的 DSL 做 24 項結構檢查
│  ├─ fix-ssrf.mjs               # 放行 Dify SSRF proxy 到本機服務
│  ├─ verify-e2e.mjs             # 端到端驗證（證據寫進 evidence/）
│  └─ cleanup-apps.mjs           # 清理重複應用
└─ evidence/                     # 驗證證據（節點執行 / seekdb 讀寫 / 記憶讀寫）
```

## 前置條件

| 項目 | 版本 / 說明 |
|---|---|
| Docker Desktop | Dify 1.19.0（官方 `langgenius/dify` compose） |
| Node.js | ≥ 20（`service/` 與 `scripts/`） |
| seekdb | Dify compose 的 `seekdb` profile 即可；服務端用 MySQL 協定連 `:2881` |
| 模型 | NVIDIA NIM：`nvidia/nemotron-3-ultra-550b-a55b`（DM）、`nvidia/nemotron-3-embed-1b`（embedding，dim 2048） |
| Dify 外掛 | `langgenius/openai_api_compatible:0.0.83`（DSL 的 `dependencies` 已宣告） |

Dify 的 `.env` 需要：

```dotenv
COMPOSE_PROFILES=seekdb,postgresql,collaboration
VECTOR_STORE=seekdb
DB_TYPE=postgresql
EXPOSE_NGINX_PORT=8080
# 匯出的 DSL 要帶「可攜的明文 dataset id」，否則換 workspace 匯入時會被靜默丟棄
DSL_EXPORT_ENCRYPT_DATASET_ID=false
```

## 運行步驟

### 1. 起 Dify

```bash
cd dify-src/docker
docker compose up -d
# 等 nginx（:8080）、api、worker、seekdb 全部 healthy
```

### 2. 初始化管理員

Dify 的 `/console/api/setup` 只能呼叫一次，管理員密碼必須同時寫在 `docker/envs/security.env` 的 `INIT_PASSWORD`。

```bash
cd dify
node scripts/setup-admin.mjs --email admin@local --name Admin --password 'Dify@2026Local'
```

### 3. 安裝模型外掛並設定 NVIDIA NIM

```bash
export NVIDIA_API_KEY=<your key>
node scripts/setup-model.mjs
```

這支腳本會（可重複執行）：

1. 安裝 `langgenius/openai_api_compatible:0.0.83` 與 `langgenius/openai:1.1.0`；
2. 用 `POST /console/api/workspaces/current/model-providers/{provider}/models/credentials` 建立憑證，再以 `POST .../models`（`config_from: "custom-model"`）啟用模型；
3. 把 LLM 與 embedding 模型設為 workspace 預設。

### 4. 建立知識庫（規則卡）

```bash
node scripts/seed-kb.mjs
```

在 Dify 建立「迷宮酒館規則庫」（向量庫 = seekdb），匯入 `data/kb/` 的 11 張規則卡，**等索引批次全部 `completed`** 才算完成。

### 5. 起 session-state 服務

```bash
cd service
cp .env.example .env       # 填入 SEEKDB_PASSWORD 與 EMBEDDING_API_KEY
npm install
npm start                  # 監聽 0.0.0.0:8787
```

> **為什麼要綁 `0.0.0.0`**：Dify 跑在 Docker 裡，容器要用 `host.docker.internal` 連到本機服務；只綁 `127.0.0.1` 的話容器連不到。

可選：先跑一次冒煙測試確認服務端與 seekdb 的讀寫都正常。

```bash
npm run smoke
```

### 6. 放行 Dify 的 SSRF proxy（必要）

Dify 的 HTTP Request 節點一律經過 `ssrf_proxy`（Squid），而 Squid 的 `to_private_networks` 規則會擋掉所有內網位址，服務端會收到 HTTP 403
`Access to '...' was blocked by SSRF protection`。

Dify 1.19.0 提供兩個逃生口，由 proxy 容器的 entrypoint 轉成 squid ACL（**放在 deny 規則之前**，所以白名單優先）：

```bash
node scripts/fix-ssrf.mjs
```

腳本會在執行時解析 `host.docker.internal` 的實際位址（不寫死）、patch `docker/.env` 的
`SSRF_PROXY_ALLOW_PRIVATE_IPS` / `SSRF_PROXY_ALLOW_PRIVATE_DOMAINS`、重建 proxy 容器，並驗證產生出來的
`/etc/squid/dify_allow_private.conf` 與 `squid -k parse`。

> proxy 容器若被 `docker compose up` 重建，必須重跑這支腳本。

### 7. 建 DSL、匯入、檢查

```bash
node scripts/build-dsl.mjs        # 模板 → dsl/maze-tavern.yml（代換 live dataset id）
node scripts/import-dsl.mjs       # 匯入 → 再從 Dify 匯出回來（保證可匯入）
node scripts/check-dsl.mjs        # 24 項結構檢查
```

`import-dsl.mjs` 匯入後會**從 Dify 重新匯出**一次，交付的 `dsl/maze-tavern.yml` 就是 Dify 自己產出的版本——匯入 1.19.0 不會出錯。

### 8. 發佈與驗證

```bash
export DIFY_ADMIN_PASSWORD='Dify@2026Local'
node scripts/verify-e2e.mjs
```

腳本會自動發佈、建立 App API Key、跑三回合對話、抓下節點執行紀錄與 seekdb 讀寫紀錄，寫進 `evidence/`。

## 怎麼玩

在 Dify 的「迷宮酒館」應用頁開聊，或直接打 API：

```bash
curl -X POST http://127.0.0.1:8080/v1/chat-messages \
  -H "Authorization: Bearer <app-api-key>" \
  -H "Content-Type: application/json" \
  -d '{"query":"我推開門，想先跟館主老霍說話。","inputs":{},"user":"player","response_mode":"blocking"}'
```

第一回合之後要帶上回傳的 `conversation_id`：

```bash
-d '{"query":"我想看看吧台下面有沒有暗格。","inputs":{},"user":"player","conversation_id":"<uuid>","response_mode":"blocking"}'
```

每回合的回答是「敘事 + 狀態列」：

```
你彎腰湊近吧台底部，指尖在潮濕的木板縫隙裡摸索。第三塊板子鬆動了——輕輕一撬，暗格無聲彈開。

*你可以：把半張星圖攤開細看、翻開帳簿第一頁、或把齒輪放在吧台上問老霍「這是什麼」*

---

**狀態**　生命 20/20　金幣 8　地點 醉月酒館　第 2 回合
```

## 會話狀態服務 API

| 方法 | 路徑 | 說明 |
|---|---|---|
| GET | `/health` | 存活檢查 + 兩個集合的列數 |
| GET | `/api/context?session_id=&q=` | **回合簡報（text/plain）**，含狀態行、近期紀錄、混合檢索結果、玩家輸入 |
| GET | `/api/state?session_id=&q=` | 讀狀態（JSON），同時寫一列 `op=read` 記憶紀錄 |
| POST | `/api/state` | 寫狀態（`state_raw` 為 JSON 字串，或直接送 `state` 物件），同時寫一列 `op=write` 記憶紀錄 |
| GET | `/api/memory?session_id=&limit=` | 記憶日誌 |
| GET | `/api/search?q=&session_id=` | 混合檢索（全文 + 向量，RRF） |
| GET | `/api/world` | 靜態世界觀種子 |

POST 的 body 同時接受 `application/json` 與 `application/x-www-form-urlencoded`——Dify 的 HTTP 節點用後者，因為 Code 節點沙箱無法序列化 JSON。

## 這個題目踩過的坑（都在程式碼裡處理了）

| 坑 | 現象 | 處理 |
|---|---|---|
| Dify 內建對話記憶 | 記憶存的是「最終回答」，回答帶著系統狀態面板 → DM 照抄面板、第 3 回合忘記輸出狀態區塊，狀態卡在第 2 回合 | DSL 完全移除 `memory:` 欄位，改由 seekdb 當記憶層 |
| Dify Code 沙箱模組白名單 | `import json` → `operation not permitted`（`re` 可以） | 狀態區塊用 regex 解析；JSON 修補用字串掃描手寫；服務端回傳純文字簡報 |
| 模型輸出被截斷 | `max_tokens=1024` 時 DM 剛好在 JSON 中間斷掉 → 服務端 400 → 整回合的寫入全丟 | `max_tokens` 提到 2048；Code 節點的 `_repair_json()` 會把截斷的 JSON 補完（保留寫完整的欄位）；服務端再留一層 scalar 搶救 |
| Squid 擋內網 | HTTP 節點 403 `blocked by SSRF protection` | `scripts/fix-ssrf.mjs` 產生 squid ACL 白名單 |
| 匯出 DSL 的 dataset id 被加密 | 加密 id 綁定租戶 key，換 workspace 匯入時被靜默丟棄，知識庫檢索節點失效 | Dify `.env` 設 `DSL_EXPORT_ENCRYPT_DATASET_ID=false` |
| `DSL 匯出` 預設回 .ifpkg | 沒有 `?format=yaml` 時端點串流 ZIP | 匯出時帶 `?format=yaml&include_secret=false` |
| seekdb 向量索引不隨寫入更新 | upsert 後立刻檢索拿不到新向量 | 寫入後呼叫 `collection.refresh_index()` |
| seekdb `'default-embed'` 預設引擎 | 建索引時報錯 | `new VectorIndexConfig({ ..., embeddingFunction: null })` |

驗證細節與完整證據見 [`VERIFICATION.md`](./VERIFICATION.md)。
