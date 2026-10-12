# ttc-data-hub

Gives Claude live access to The Tobacco Center's business data. It mirrors
**Clover** and the TTC **Cloudflare KV** namespaces into a D1 database
(`ttc_hub`) every 5 minutes and serves everything as an MCP connector.

```
Clover REST API ──┐                         ┌── Claude (claude.ai / app / Claude Code)
TTC Ops KV ───────┤  cron */5 → D1 ttc_hub  │     custom connector:
TTC_CUSTOMERS KV ─┼────────────────────────►├──  https://ttc-data-hub.williamsportcigars.workers.dev/mcp/<MCP_KEY>
TTC_LOCATOR KV ───┤                         │
Zapier webhooks ──┘  POST /ingest/<source>  └── also read-only: cash_flow_companion, ttc_schedule, clover_history D1
```

This worker only **reads** Clover and KV. It never changes Clover, and it
never writes to the KV namespaces the other workers use.

## What gets mirrored

| Clover data | Table | Refresh |
|---|---|---|
| Orders + line items, modifiers, discounts | `orders`, `line_items`, `order_discounts` | every 5 min (incremental on modifiedTime, full history backfill from `BACKFILL_START`) |
| Payments, refunds, credits | `payments`, `refunds`, `credits` | every 5 min |
| Stock levels | `item_stocks` | every 10 min |
| Items (price, cost, UPC, SKU, categories, tags) | `items`, `item_categories` | hourly |
| Customers (phones, emails, marketing opt-in) | `customers` | every 3 h |
| Employees, shifts, cash drawer events | `employees`, `shifts`, `cash_events` | 5 min – 6 h |
| Categories, tags, item groups, modifier groups, attributes, tenders, tax rates, order types, discounts, roles, devices, opening hours, merchant profile | `catalog` | 6–24 h |
| All keys of TTC Ops, TTC_CUSTOMERS, TTC_LOCATOR_KV | `kv_entries` | every 30 min (live reads also available) |
| Anything Zapier POSTs | `events` | instantly |

Views: `v_sales_lines` (line items that count as sales, net of all
discounts) and `v_inventory` (active items with on-hand stock).

If the Clover token can't read something (for example employees or shifts),
that resource shows the error in `sync_status` and retries every 6 hours.
Everything else keeps syncing.

## Claude tools

`business_snapshot`, `sales_summary`, `inventory`, `reorder_suggestions`,
`slow_movers`, `customer_lookup`, `sql_query` (read-only; hub, cashflow,
schedule, legacy_clover), `describe_data`, `kv_list`, `kv_get`,
`clover_api_get` (live read-only Clover passthrough), `sync_status`,
`sync_now`.

## Setup

1. **Clover token**: the only thing not set automatically.
   ```
   npx wrangler secret put CLOVER_TOKEN
   ```
   Or in the Cloudflare dashboard: Workers & Pages → ttc-data-hub → Settings →
   Variables and Secrets → Add → Secret `CLOVER_TOKEN`. Use a Clover API token
   with read permission for Orders, Payments, Inventory, Customers, Employees
   and Merchant (Clover web dashboard → Account & Setup → API Tokens).
2. **Connect Claude**: in claude.ai go to Settings → Connectors → Add custom
   connector, name it "TTC Data", and paste the URL
   `https://ttc-data-hub.williamsportcigars.workers.dev/mcp/<MCP_KEY>`.
3. The first history backfill runs on its own: 25 Clover pages every 5
   minutes. To speed it up, call
   `POST /sync?key=<MCP_KEY>&budget=300` a few times (or ask Claude to run
   `sync_now` with a big budget). On Workers Paid you can raise
   `MAX_REQUESTS_PER_RUN` in `wrangler.toml`.

`MCP_KEY` is a secret. Anyone with the connector URL can read the data, so
treat it like a password. To rotate it, run `npx wrangler secret put MCP_KEY`
and update the connector URL.

## Zapier → hub

In any Zap, add **Webhooks by Zapier → POST**:
- URL: `https://ttc-data-hub.williamsportcigars.workers.dev/ingest/<source-name>`
- Headers: `X-Hub-Key: <MCP_KEY>`
- Payload type: JSON

The data lands in the `events` table, where Claude can query it.

## Develop / deploy

```
npm install
npm test                                 # unit tests (transforms, SQL guard)
node test/mock-clover.mjs 8789 &         # fake Clover API
npx wrangler dev --local                 # uses .dev.vars (see below)
npx wrangler deploy                      # schema.sql is applied automatically
```

`.dev.vars` for local runs:
```
CLOVER_TOKEN=test-token
CLOVER_MID=MOCKMID
CLOVER_API_BASE=http://127.0.0.1:8789
MCP_KEY=localtestkey
BACKFILL_START=2026-01-01T00:00:00Z
```

Money in tables is **cents**. Times are epoch ms, with `*_local` columns in
`America/New_York`.
