// Turn briefing for the DM.
//
// Why plain text?
// --------------
// Dify's Code-node sandbox exposes only a tiny module allowlist (`re` works,
// `json` does not), so the workflow cannot parse the service's JSON response.
// Instead of shipping a JSON blob into the prompt and paying for a hand-rolled
// parser, the service renders the whole context as plain text:
//
//   hp=20/20 gold=8 location=燭火廳 turn=2 death=0
//
// The chatflow injects it straight into the DM prompt, and the Code node only
// has to regex a couple of key/value pairs out of it for the status panel.
//
// The briefing is assembled from seekdb:
//   * the session state row  (authoritative game state)
//   * the memory log rows    (recent turns + hybrid full-text/vector recall)

const MAX_HISTORY = 6;
const MAX_ITEM = 160;
const MAX_NARRATIVE = 220;

/** Collapse whitespace and clip — the briefing is prompt material, not prose. */
export function oneLine(text, max = MAX_ITEM) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/**
 * The machine-readable status lines.
 *
 * `location` is deliberately last on the first line so that a room name with
 * a space cannot confuse the Code node's `location=(\S+)` regex.
 */
export function formatState(state) {
  const s = state ?? {};
  const items = Array.isArray(s.inventory) ? s.inventory : [];
  const flags = Object.entries(s.flags ?? {});
  const stats = s.stats ?? {};
  return [
    `hp=${s.hp}/${s.hp_max} gold=${s.gold} turn=${s.turn} death=${s.death_count ?? 0} location=${s.location}`,
    `inventory=${items.length ? items.map((item) => oneLine(item, 40)).join(", ") : "(空)"}`,
    `flags=${flags.length ? flags.map(([key, value]) => `${key}=${value}`).join(", ") : "(無)"}`,
    `stats=str:${stats.str},agi:${stats.agi},int:${stats.int},wil:${stats.wil}`,
  ];
}

/**
 * Build the briefing.
 *
 * @param {object} options
 * @param {object} options.state          the session state row
 * @param {Array}  options.history        memory-log rows, newest first
 * @param {Array}  options.recall         hybrid-search hits
 * @param {string} options.recallMode     "hybrid" | "list"
 * @param {string} options.playerInput    what the player just did
 */
export function buildContext({
  state,
  history = [],
  recall = [],
  recallMode = "list",
  playerInput = "",
}) {
  const lines = [];

  lines.push("# 迷宮酒館｜回合簡報（資料來源：seekdb）");
  lines.push("");
  lines.push("## 目前狀態");
  lines.push(...formatState(state));
  lines.push("");
  lines.push("## 玩家本回合行動");
  lines.push(oneLine(playerInput, 300) || "(無)");
  lines.push("");
  lines.push("## 近期紀錄（seekdb 記憶日誌）");

  const turns = history.filter((entry) => entry?.op === "write").slice(0, MAX_HISTORY);
  if (!turns.length) {
    lines.push("(尚無紀錄，這是第一回合)");
  } else {
    for (const entry of turns) {
      lines.push(`第${entry.turn}回合 玩家: ${oneLine(entry.player_input) || "(無)"}`);
      if (entry.summary) lines.push(`第${entry.turn}回合 DM: ${oneLine(entry.summary, MAX_NARRATIVE)}`);
    }
  }
  lines.push("");
  lines.push(`## 檢索記憶（fulltext + vector，RRF 融合；mode=${recallMode}）`);

  if (!recall.length) {
    lines.push("(無命中)");
  } else {
    for (const entry of recall) {
      const parts = [`第${entry.turn}回合`, entry.op || "?"];
      if (entry.player_input) parts.push(`玩家: ${oneLine(entry.player_input)}`);
      if (entry.delta) parts.push(`變化: ${oneLine(entry.delta, 120)}`);
      lines.push(parts.join(" | "));
    }
  }

  return lines.join("\n");
}
