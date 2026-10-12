// Minimal read-only Clover REST v3 client.

export class CloverError extends Error {
  constructor(status, body, path) {
    super(`Clover ${status} on ${path}: ${body}`);
    this.status = status;
  }
}

export class Clover {
  constructor(env) {
    if (!env.CLOVER_TOKEN) throw new Error("CLOVER_TOKEN secret is not set");
    if (!env.CLOVER_MID) throw new Error("CLOVER_MID is not set");
    const host = (env.CLOVER_API_BASE || "https://api.clover.com").replace(/\/$/, "");
    this.base = `${host}/v3/merchants/${env.CLOVER_MID}`;
    this.token = env.CLOVER_TOKEN;
    this.requests = 0;
  }

  // path is relative to the merchant ("" for the merchant itself, "/orders", ...).
  // params values may be arrays (repeated keys, e.g. multiple `filter`s).
  async get(path, params = {}) {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(params)) {
      if (v == null || v === "") continue;
      for (const one of Array.isArray(v) ? v : [v]) url.searchParams.append(k, String(one));
    }
    for (let attempt = 0; ; attempt++) {
      this.requests++;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${this.token}`, Accept: "application/json" } });
      if (r.status === 429 && attempt < 2) {
        const wait = Math.min(Number(r.headers.get("retry-after")) || 1, 3);
        await new Promise((res) => setTimeout(res, wait * 1000));
        continue;
      }
      if (!r.ok) throw new CloverError(r.status, (await r.text()).slice(0, 300), path);
      return r.json();
    }
  }
}
