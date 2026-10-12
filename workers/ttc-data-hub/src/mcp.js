// Stateless MCP server over Streamable HTTP (JSON responses, no SSE).
// Claude connects to POST /mcp/<MCP_KEY>.

import { TOOLS } from "./tools.js";

const SUPPORTED = ["2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS = `Live business data for The Tobacco Center (Williamsport, PA): Clover POS sales, inventory, customers, employees and payments, mirrored every 5 minutes, plus the TTC Cloudflare KV data (cigar details, customer humidors, ops/planning notes), cash-flow and staff-schedule databases.
Start with business_snapshot for a quick picture or describe_data before writing SQL. Prefer the purpose-built tools (sales_summary, inventory, reorder_suggestions, slow_movers, customer_lookup) and fall back to sql_query for anything else. Tool output is in dollars; raw tables are in cents. Use clover_api_get for live data that is not mirrored, and sync_now if the user needs the last few minutes.`;

const ok = (id, result) => ({ jsonrpc: "2.0", id, result });
const err = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

async function handle(env, msg) {
  const { id, method, params = {} } = msg || {};
  const isNotification = id === undefined || id === null;
  switch (method) {
    case "initialize": {
      const v = SUPPORTED.includes(params.protocolVersion) ? params.protocolVersion : SUPPORTED[0];
      return ok(id, { protocolVersion: v, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "ttc-data-hub", version: "1.0.0" }, instructions: INSTRUCTIONS });
    }
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema, annotations: { readOnlyHint: name !== "sync_now", openWorldHint: false } })) });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) return err(id, -32602, `Unknown tool: ${params.name}`);
      try {
        const result = await tool.run(env, params.arguments || {});
        return ok(id, { content: [{ type: "text", text: JSON.stringify(result) }] });
      } catch (e) {
        return ok(id, { isError: true, content: [{ type: "text", text: `Error: ${e.message || e}` }] });
      }
    }
    case "resources/list": return ok(id, { resources: [] });
    case "prompts/list": return ok(id, { prompts: [] });
    default:
      if (isNotification) return null;
      return err(id, -32601, `Method not found: ${method}`);
  }
}

export async function handleMcp(request, env) {
  if (request.method === "GET") return new Response("Use POST (stateless MCP server)", { status: 405, headers: { Allow: "POST" } });
  if (request.method === "DELETE") return new Response(null, { status: 204 });
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  let body;
  try { body = await request.json(); } catch { return Response.json(err(null, -32700, "Parse error"), { status: 400 }); }
  const batch = Array.isArray(body);
  const replies = (await Promise.all((batch ? body : [body]).map((m) => handle(env, m)))).filter(Boolean);
  if (!replies.length) return new Response(null, { status: 202 });
  return Response.json(batch ? replies : replies[0]);
}
