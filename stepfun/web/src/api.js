// Thin wrapper over the local backend JSON API.

async function request(path, options) {
  const response = await fetch(path, options);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`backend returned non-JSON for ${path}`);
  }
  if (!response.ok) {
    throw new Error(body?.error ?? `request failed: ${response.status}`);
  }
  return body;
}

export const api = {
  health: () => request("/api/health"),
  stats: () => request("/api/stats"),
  ingest: (items) =>
    request("/api/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items }),
    }),
  search: (payload) =>
    request("/api/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
  verify: (id, embedding) =>
    request("/api/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, embedding }),
    }),
  reset: () => request("/api/reset", { method: "POST" }),
  corpus: () =>
    fetch("/api/corpus")
      .then((response) => response.text())
      .then((text) =>
        text
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => {
            const parsed = JSON.parse(line);
            return { id: String(parsed.id), text: String(parsed.text), metadata: parsed.metadata ?? {} };
          }),
      ),
  evalSet: () => request("/api/eval"),
};
