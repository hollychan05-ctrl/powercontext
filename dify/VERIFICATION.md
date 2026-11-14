# 驗證記錄 · 迷宮酒館（Dify × OceanBase seekdb）

本文件記錄「迷宮酒館」Chatflow 的實測結果。全部數據來自一次真實的端到端執行
（`node scripts/verify-e2e.mjs`），原始證據檔在 [`evidence/`](./evidence/)。

- **執行時間**：2026-11-14 14:04:23（UTC+8 22:04）
- **環境**：Dify 1.19.0（Docker compose）、OceanBase seekdb `:2881`、Node.js v24.18.0
- **模型**：`nvidia/nemotron-3-ultra-550b-a55b`（DM）、`nvidia/nemotron-3-embed-1b`（embedding, dim 2048）

## 1. 總覽

| 驗收項 | 結果 |
|---|---|
| DSL 匯入 | `status: completed`，`warnings: []`，`current_dsl_version = imported_dsl_version = 0.7.0` |
| DSL 結構檢查 | **24 / 24 通過**（`scripts/check-dsl.mjs`） |
| 應用發佈 | `POST /workflows/publish` → `{"result":"success"}` |
| 對話回合 | 3 回合全部成功 |
| 節點執行紀錄 | **21 條**（3 回合 × 7 節點），`failed_nodes: []` |
| seekdb 狀態列 | 1 列／工作階段，`turn = 3` |
| 記憶讀寫紀錄 | **7 條**，`op = read,write,read,write,read,write,read` |
| 知識庫檢索 | 每回合取回 4 張相關規則卡（top_k = 4） |

## 2. 節點執行紀錄

每回合 7 個節點全部 `succeeded`。節點型態涵蓋 `start` / `http-request` /
`knowledge-retrieval` / `llm` / `code` / `http-request` / `answer`。

| 節點 | 型態 | 回合 1 | 回合 2 | 回合 3 |
|---|---|---|---|---|
| `start` | start | 0.00 s | 0.00 s | 0.00 s |
| `get_context` | http-request（讀 seekdb） | 1.47 s | 0.88 s | 0.79 s |
| `retrieve_rules` | knowledge-retrieval（seekdb 向量庫） | 5.61 s | 3.66 s | 4.11 s |
| `dm` | llm（DM） | 29.43 s | 13.94 s | 30.75 s |
| `parse_state` | code | 0.33 s | 0.33 s | 0.45 s |
| `save_state` | http-request（寫 seekdb） | 2.81 s | 3.16 s | 3.00 s |
| `answer` | answer | 0.00 s | 0.00 s | 0.00 s |

LLM 用量（NVIDIA NIM 回報）：

| 回合 | prompt tokens | completion tokens | total | 首 token | 整段 |
|---|---|---|---|---|---|
| 1 | 2,472 | 574 | 3,046 | 24.65 s | 29.46 s |
| 2 | 2,709 | 583 | 3,292 | 9.67 s | 13.92 s |
| 3 | 3,148 | 1,083 | 4,231 | 21.80 s | 30.81 s |

原始紀錄：[`evidence/node-executions.json`](./evidence/node-executions.json)
（每條含 `inputs`、`outputs`、`status`、`elapsed_time`、`error`）。

### 2.1 知識庫檢索真的走 seekdb

`retrieve_rules` 每回合回傳 4 張規則卡，內容與當前情境相關：

| 回合 | 取回的規則卡（前 4 張） |
|---|---|
| 1 | 場景設定：迷宮階梯井 / 難度對照 / 失敗、死亡與重來 / 謎題、線索與旗標 |
| 2 | 場景設定：醉月酒館・燭火廳 / 場景設定：迷宮階梯井 / 謎題、線索與旗標 / 傷害與狀態 |
| 3 | 場景設定：醉月酒館・燭火廳 / DM 核心規則（迷宮酒館）/ 場景設定：迷宮階梯井 / 世界觀與勢力 |

知識庫本體位於 Dify 的 seekdb 向量庫（資料表 `vector_index_<dataset_uuid>_node`，
schema `id varchar(36) PK, vector VECTOR(2048), text longtext, metadata json`），
11 張規則卡全部 `completed`。

## 3. seekdb 讀寫紀錄

### 3.1 狀態列（`maze_tavern_state`，一列／工作階段）

```json
{
  "hp": 20,
  "hp_max": 20,
  "gold": 8,
  "location": "階梯井",
  "turn": 3,
  "inventory": [],
  "flags": {},
  "stats": { "str": 3, "agi": 4, "int": 5, "wil": 4 },
  "death_count": 0
}
```

`turn` 從 0（未建立）走到 3，`location` 從「燭火廳」變成「階梯井」——說明每一回合的
狀態更新都真的落庫並被下一回合讀回來。原始紀錄：[`evidence/seekdb-records.json`](./evidence/seekdb-records.json)。

### 3.2 記憶日誌（`maze_tavern_memory`，一列／回合）

| seq | op | turn | location | player_input | summary（DM 敘事） |
|---|---|---|---|---|---|
| 1 | read | 0 | 燭火廳 | 我推開門，想先跟館主老霍說話。 | `read state (new session)` |
| 2 | write | 1 | 燭火廳 | 我推開門，想先跟館主老霍說話。 | 你推開「醉月」那扇佈滿刀痕的橡木門… |
| 3 | read | 1 | 燭火廳 | 我想看看吧台下面有沒有暗格。 | `read state (stored)` |
| 4 | write | 2 | 燭火廳 | 我想看看吧台下面有沒有暗格。 | 你彎腰湊近吧台底板，指尖觸到一道幾乎看不見的細縫… |
| 5 | read | 2 | 燭火廳 | 我要離開酒館，往迷宮走。 | `read state (stored)` |
| 6 | write | 3 | 階梯井 | 我要離開酒館，往迷宮走。 | 你推開北側那扇佈滿劍痕的鐵釘門，一股乾冷… |
| 7 | read | 3 | 階梯井 | —（驗證腳本的最終讀取） | `read state (stored)` |

這張表就是賽題要求的「**記憶讀寫紀錄**」：

- 每回合一次 `read`（`get_context` 節點 → `GET /api/context`）與一次 `write`
  （`save_state` 節點 → `POST /api/state`），共 7 條；
- `write` 紀錄的 `summary` 欄位存的是 DM 的敘事本體，所以下一回合的回合簡報可以
  **直接從資料庫重建「發生了什麼」**，不必靠 Dify 的對話記憶；
- `delta` 欄位記錄狀態差異（例如 `moved 燭火廳->階梯井`）。

### 3.3 集合現況

```json
{
  "collections": {
    "state":  { "name": "maze_tavern_state",  "rows": 13 },
    "memory": { "name": "maze_tavern_memory", "rows": 57 }
  }
}
```

（列數含先前幾次驗證與 `demo-session` 種子資料。）

兩個集合都建了**全文索引 + HNSW 向量索引**（dim 2048，cosine，analyzer `ik`），
混合檢索用 RRF 融合；`GET /api/search?q=…` 走的就是這條路徑。

## 4. 對話樣例

完整逐字稿見 [`evidence/e2e-transcript.json`](./evidence/e2e-transcript.json)。
以下為節錄。

### 回合 1

> **玩家**：我推開門，想先跟館主老霍說話。
>
> **DM**：你推開沉重的木門，一股混著燒酒與陳年木頭的氣味撲面而來，昏黃的燭光在吧台後的老霍臉上跳動。老霍正用抹布擦拭一只缺口的酒杯，眼神輕輕掃過你，嘴角勾起一絲不易察覺的笑意。四周幾張桌邊的醉客低聲爭吵，角落的暗格微微露出一角紙頁。
>
> *你可以：走到吧台詢問老霍關於月門的事、查看吧台下的暗格、或先觀察四周的醉客。*
>
> ---
>
> **狀態**　生命 20/20　金幣 8　地點 醉月酒館　第 1 回合

### 回合 2

> **玩家**：我想看看吧台下面有沒有暗格。
>
> **DM**：你彎腰湊近吧台底部，指尖在潮濕的木板縫隙裡摸索。第三塊板子鬆動了——輕輕一撬，暗格無聲彈開。裡面躺著三樣東西：一張撕成兩半的星圖（只剩下半張）、一本沒有書名、封面泛黃的旅館帳簿、還有一枚不鏽的黃銅齒輪，冷冰冰貼在掌心。老霍依然在擦杯子，卻把抹布停在半空，眼神落在你手中的齒輪上，彷彿在等你開口。
>
> *你可以：把半張星圖攤開細看、翻開帳簿第一頁、或把齒輪放在吧台上問老霍「這是什麼」。*
>
> ---
>
> **狀態**　生命 20/20　金幣 8　地點 醉月酒館　第 2 回合

### 回合 3

> **玩家**：我要離開酒館，往迷宮走。
>
> **DM**：你站起身，椅腳在地板上劃出一道尖銳的嘶鳴，驚動幾桌醉客的低語。老霍手中的抹布終於停下，眼神從齒輪移到你臉上，聲音沙啞像乾柴燃燒：「北門通階梯井，七層樓梯數字愛變臉；後門通後巷，白貓會帶路，但雨水倒流的地方別久留。」他指了指吧台牆上刻滿名字的木板，你的名字下已有兩筆劃記，「第三次若再回來，酒錢我就記在織夢者帳上了。」昏黃燭火隨著一陣無風自動的氣流跳躍，北門與後門在影子裡張著兩張不同的嘴。
>
> *你可以：推開北門進入階梯井、轉身走向後巷找白貓、或在老霍話音未落時追問「織夢者帳上」是什麼意思。*
>
> ---
>
> **狀態**　生命 20/20　金幣 8　地點 階梯井　第 3 回合

**一致性檢查**（程式化驗證，非人工目視）：

| 回合 | 串流回答長度 | Answer 節點輸出長度 | 逐字相同 | 提示行數 | 狀態面板數 |
|---|---|---|---|---|---|
| 1 | 197 | 197 | ✅ | 1 | 1 |
| 2 | 193 | 193 | ✅ | 1 | 1 |
| 3 | 331 | 331 | ✅ | 1 | 1 |

每一回合恰好一條斜體提示、恰好一個狀態面板、沒有重複的「**狀態**」列，
` ```state ` 區塊也沒有漏到敘事裡。

## 5. 服務端自身的驗證

`service/scripts/smoke.mjs` 會跑 7 段端到端檢查（獨立的入口點，不依賴 Dify）：

```
1. /health                     → 服務連得上 seekdb
2. GET  /api/state             → 讀新工作階段（seekdb READ + 記憶紀錄）
3. POST /api/state             → 寫入 patch（seekdb WRITE + 記憶紀錄）
4. GET  /api/state             → 寫入的狀態真的持久化了
5. GET  /api/memory            → 記憶日誌同時有 read 與 write 紀錄
6. GET  /api/search            → 混合檢索（全文 + 向量）
7. GET  /api/world             → 靜態世界觀種子
```

實測結果：**ALL CHECKS PASSED**（state rows 3、memory rows 7）。

## 6. 重現步驟

```bash
# 0. Dify 已在 8080、seekdb 已在 2881，SSRF 白名單已放行
#    （node scripts/fix-ssrf.mjs）

# 1. 知識庫 + 模型 + 服務
node scripts/seed-kb.mjs
node scripts/setup-model.mjs            # 需要 NVIDIA_API_KEY
cd service && npm install && npm start &

# 2. DSL
node scripts/build-dsl.mjs
node scripts/import-dsl.mjs
node scripts/check-dsl.mjs              # 24/24

# 3. 端到端驗證（重新產生 evidence/ 底下所有檔案）
export DIFY_ADMIN_PASSWORD='...'
node scripts/verify-e2e.mjs
```

## 7. 本次驗證修掉的問題

| 問題 | 根因 | 修法 |
|---|---|---|
| 第 3 回合狀態卡住不動 | Dify 內建對話記憶把「最終回答」（含系統狀態面板）餵回 DM，DM 照抄面板、忘記輸出 ` ```state ` 區塊 | DSL 移除 `memory:` 欄位，改由 seekdb 當記憶層 |
| 提示行重複出現 | DM 有時在敘事裡與狀態區塊後各給一次提示 | Code 節點的 `_keep_last_hint()` 只保留最後一條 |
| `save_state` 回 HTTP 400 | `max_tokens=1024` 時 DM 剛好在 JSON 中間斷掉，服務端解析失敗 → 整回合寫入被丟棄 | `max_tokens` 提到 2048；Code 節點 `_repair_json()` 補完截斷的 JSON；服務端再留一層 scalar 搶救 |
| 節點執行紀錄抓不到 | Console 的 workflow-run 清單預設只顯示 `triggered_from=debugging`，API key 觸發的是 `app-run` | 查詢加上 `?triggered_from=app-run` |
| 串流回答少了狀態面板 | Dify 的 `message` 事件帶的是增量片段，不是完整回答 | 把所有 `message` 事件的 `answer` 串接起來 |

以上五點都在程式碼裡有對應的處理，且都有自動化檢查（`check-dsl.mjs` 24 項 +
Code 節點的 6 個樣本測試 + `smoke.mjs` 的 7 段檢查 + `verify-e2e.mjs` 的端到端驗證）。
