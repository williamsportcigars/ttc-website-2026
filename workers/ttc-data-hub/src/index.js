// ttc-data-hub: mirrors Clover + TTC KV into D1 and serves it to Claude as an
// MCP connector.
//
// Routes (all except /health need MCP_KEY, as a path segment, ?key= or
// "Authorization: Bearer <key>"):
//   POST /mcp/<key>            MCP endpoint — add this URL as a custom connector in Claude
//   POST /sync?key=..&budget=N run a sync now (used to drive the initial backfill)
//   GET  /status?key=..        sync status JSON
//   POST /ingest/<source>?key=..  store any JSON payload (Zapier "Webhooks by Zapier" POST)
//   GET  /health               liveness, no data

import { handleMcp } from "./mcp.js";
import { runSync } from "./sync.js";
import { TOOLS } from "./tools.js";
import { toLocal } from "./transform.js";
import { ensureSchema } from "./schema.js";

function timingSafeEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function keyFrom(request, url, pathKey) {
  const auth = request.headers.get("authorization") || "";
  return pathKey || url.searchParams.get("key") || request.headers.get("x-hub-key") || (auth.startsWith("Bearer ") ? auth.slice(7) : "");
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const route = parts[0] || "";

    if (route === "health") return Response.json({ ok: true });
    if (!env.MCP_KEY) return new Response("MCP_KEY secret not set", { status: 503 });

    const pathKey = route === "mcp" ? parts[1] : undefined;
    if (!timingSafeEqual(keyFrom(request, url, pathKey), env.MCP_KEY)) return new Response("Not found", { status: 404 });
    await ensureSchema(env.DB);

    switch (route) {
      case "mcp":
        return handleMcp(request, env);
      case "sync": {
        if (request.method !== "POST") return new Response("POST only", { status: 405 });
        const only = url.searchParams.get("only");
        return Response.json(await runSync(env, { budget: url.searchParams.get("budget"), only: only ? only.split(",") : undefined, force: url.searchParams.get("force") === "1" }));
      }
      case "status":
        return Response.json(await TOOLS.find((t) => t.name === "sync_status").run(env, {}));
      case "ingest": {
        if (request.method !== "POST") return new Response("POST only", { status: 405 });
        const source = (parts[1] || "zapier").slice(0, 64);
        const text = await request.text();
        if (text.length > 1_000_000) return new Response("Payload too large", { status: 413 });
        const now = Date.now();
        await env.DB.prepare("INSERT INTO events (source, received_at, received_local, payload) VALUES (?, ?, ?, ?)")
          .bind(source, now, toLocal(now, env.TIMEZONE || "America/New_York"), text).run();
        return Response.json({ ok: true });
      }
      default:
        return new Response("Not found", { status: 404 });
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(ensureSchema(env.DB).then(() => runSync(env)).then((r) => console.log(JSON.stringify(r))));
  },
};
