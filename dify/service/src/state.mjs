// Player-state shaping: defaults, sanitising, and the serialised document form.

/** The starting state of a brand-new adventurer in the 燭火廳. */
export function defaultState() {
  return {
    hp: 20,
    hp_max: 20,
    gold: 8,
    location: "燭火廳",
    turn: 0,
    inventory: [],
    flags: {},
    stats: { str: 3, agi: 4, int: 5, wil: 4 },
    death_count: 0,
    last_narrative: "",
  };
}

const INT_FIELDS = ["hp", "hp_max", "gold", "turn", "death_count"];
const STAT_FIELDS = ["str", "agi", "int", "wil"];

function clampInt(value, fallback, min, max) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

/**
 * Merge an incoming state patch onto the current state.
 *
 * The DM emits a partial patch; unknown keys are dropped and known keys are
 * range-checked, so a malformed LLM response can never corrupt the stored
 * session (the stored state is what the next turn starts from).
 */
export function mergeState(current, patch) {
  const base = { ...defaultState(), ...(current ?? {}) };
  const incoming = patch && typeof patch === "object" ? patch : {};
  const next = { ...base };

  for (const field of INT_FIELDS) {
    if (field in incoming) {
      const limits = {
        hp: [-99, 999],
        hp_max: [1, 999],
        gold: [0, 999999],
        turn: [0, 999999],
        death_count: [0, 9999],
      }[field];
      next[field] = clampInt(incoming[field], base[field], limits[0], limits[1]);
    }
  }
  if (next.hp > next.hp_max) next.hp = next.hp_max;

  if (typeof incoming.location === "string" && incoming.location.trim()) {
    next.location = incoming.location.trim().slice(0, 80);
  }
  if (typeof incoming.last_narrative === "string") {
    next.last_narrative = incoming.last_narrative.slice(0, 4000);
  }

  if (Array.isArray(incoming.inventory)) {
    const items = incoming.inventory
      .filter((item) => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
    next.inventory = [...new Set(items)].slice(0, 40);
  }

  if (incoming.flags && typeof incoming.flags === "object" && !Array.isArray(incoming.flags)) {
    const flags = { ...(base.flags ?? {}) };
    for (const [key, value] of Object.entries(incoming.flags)) {
      if (!/^[a-z0-9_]{1,40}$/.test(key)) continue;
      if (typeof value === "boolean" || typeof value === "number") flags[key] = value;
      else if (typeof value === "string") flags[key] = value.slice(0, 200);
    }
    next.flags = flags;
  }

  if (incoming.stats && typeof incoming.stats === "object" && !Array.isArray(incoming.stats)) {
    const stats = { ...(base.stats ?? {}) };
    for (const field of STAT_FIELDS) {
      if (field in incoming.stats) {
        stats[field] = clampInt(incoming.stats[field], base.stats?.[field] ?? 3, 1, 6);
      }
    }
    next.stats = stats;
  }

  return next;
}

/**
 * Flatten a state into the searchable document text.
 *
 * seekdb stores one row per session; the document body is what the full-text
 * index sees, so the important bits (location, carried items, world flags) are
 * spelled out in prose instead of raw JSON.
 */
export function stateToDocument(sessionId, state) {
  const flags = Object.entries(state.flags ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
  return [
    `session ${sessionId}`,
    `location ${state.location}`,
    `hp ${state.hp}/${state.hp_max}`,
    `gold ${state.gold}`,
    `turn ${state.turn}`,
    `inventory ${(state.inventory ?? []).join(", ") || "none"}`,
    `flags ${flags || "none"}`,
    `stats str=${state.stats?.str} agi=${state.stats?.agi} int=${state.stats?.int} wil=${state.stats?.wil}`,
    state.last_narrative ? `last ${state.last_narrative}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** One-line human summary of a memory entry, used as the searchable body. */
export function memoryToDocument(entry) {
  return [
    `turn ${entry.turn}`,
    entry.op === "read" ? "read" : "write",
    entry.player_input ? `player said: ${entry.player_input}` : "",
    entry.summary ? `summary: ${entry.summary}` : "",
    entry.location ? `location ${entry.location}` : "",
    entry.delta ? `delta: ${entry.delta}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
