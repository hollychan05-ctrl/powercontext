// Minimal Dify console API client: cookie jar + JSON helpers.
//
// The console API authenticates with cookies (`access_token` / `refresh_token`
// are set via Set-Cookie), so every request has to carry the session jar.
export class DifyConsole {
  constructor(baseUrl = "http://127.0.0.1:8080") {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.cookies = new Map();
    this.accessToken = null;
  }

  cookieHeader() {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  absorb(response) {
    const raw = response.headers.getSetCookie?.() ?? [];
    for (const line of raw) {
      const [pair] = line.split(";");
      const index = pair.indexOf("=");
      if (index <= 0) continue;
      this.cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
    }
  }

  async request(method, path, { body, headers = {}, raw = false } = {}) {
    const requestHeaders = { ...headers };
    const cookie = this.cookieHeader();
    if (cookie) requestHeaders.cookie = cookie;
    if (this.accessToken) requestHeaders.authorization = `Bearer ${this.accessToken}`;
    // Dify's console API requires the CSRF token to be echoed back in a header,
    // matching the `csrf_token` cookie (`X-CSRF-Token`).
    const csrf = this.cookies.get("csrf_token");
    if (csrf) requestHeaders["X-CSRF-Token"] = csrf;
    if (body !== undefined) requestHeaders["content-type"] = "application/json";

    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: requestHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(120_000),
    });
    this.absorb(response);

    const text = await response.text();
    let json = null;
    if (!raw && text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return {
      status: response.status,
      ok: response.ok,
      json,
      text,
      headers: response.headers,
    };
  }

  get(path, options) {
    return this.request("GET", path, options);
  }

  post(path, body, options) {
    return this.request("POST", path, { body, ...options });
  }

  patch(path, body, options) {
    return this.request("PATCH", path, { body, ...options });
  }

  put(path, body, options) {
    return this.request("PUT", path, { body, ...options });
  }

  delete(path, options) {
    return this.request("DELETE", path, options);
  }

  /**
   * Complete the first-run setup (admin account) and log in.
   *
   * The console expects the password field to be Base64-encoded on `/login`
   * (`decrypt_password_field` -> `FieldEncryption.decrypt_field`, which is a
   * plain Base64 decode used as transport obfuscation). `/setup` and `/init`
   * take the password verbatim.
   */
  async bootstrap({ email, name, password, initPassword }) {
    // The setup is one-shot: once finished, `/init` and `/setup` answer 403.
    // Detect that up front so the script is re-runnable.
    const current = await this.get("/console/api/setup");
    const alreadyDone = current?.json?.step === "finished";

    if (!alreadyDone) {
      const init = await this.post("/console/api/init", { password: initPassword });
      if (!init.ok && init.status !== 409) {
        throw new Error(`init failed: HTTP ${init.status} ${init.text.slice(0, 300)}`);
      }
      const setup = await this.post("/console/api/setup", { email, name, password });
      if (!setup.ok && setup.status !== 409) {
        throw new Error(`setup failed: HTTP ${setup.status} ${setup.text.slice(0, 300)}`);
      }
    }

    const login = await this.post("/console/api/login", {
      email,
      password: Buffer.from(password, "utf8").toString("base64"),
      remember_me: true,
      language: "zh-Hans",
    });
    if (!login.ok) {
      throw new Error(`login failed: HTTP ${login.status} ${login.text.slice(0, 300)}`);
    }
    return { setup: alreadyDone ? "already-finished" : "created", login: login.status };
  }
}
