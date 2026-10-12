// The tools Claude sees. Each returns a plain JSON-able object.
// Money in tool output is DOLLARS (converted from Clover cents).

import { readOnlySql } from "./sqlguard.js";
import { toLocal, normPhone } from "./transform.js";
import { Clover } from "./clover.js";
import { runSync, RESOURCES, kvNamespaces } from "./sync.js";

const $ = (c) => (c == null ? null : Math.round(Number(c)) / 100);
const tzOf = (env) => env.TIMEZONE || "America/New_York";
const today = (env) => toLocal(Date.now(), tzOf(env)).slice(0, 10);
function addDays(ymd, n) {
  const d = new Date(ymd + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const isYmd = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const all = async (db, sql, ...binds) => (await db.prepare(sql).bind(...binds).all()).results;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const DATABASES = {
  hub: { binding: "DB", about: "Clover mirror (orders, line items, payments, items, stock, customers, employees, ...), KV mirror, Zapier/webhook events" },
  cashflow: { binding: "CASHFLOW_DB", about: "cash-flow-companion app data (cashflow, cashflow_history)" },
  schedule: { binding: "SCHEDULE_DB", about: "staff scheduling app (employees, shifts, time_off_requests, swap_requests, ...)" },
  legacy_clover: { binding: "LEGACY_CLOVER_DB", about: "older clover_history database (purchase_history)" },
};
function dbFor(env, name = "hub") {
  const d = DATABASES[name];
  if (!d || !env[d.binding]) throw new Error(`Unknown database '${name}'. Options: ${Object.keys(DATABASES).filter((k) => env[DATABASES[k].binding]).join(", ")}`);
  return env[d.binding];
}

function range(env, args, defaultDays = 7) {
  const end = isYmd(args.end) ? args.end : today(env);
  const start = isYmd(args.start) ? args.start : addDays(end, -(defaultDays - 1));
  return { start, end };
}

const HUB_NOTES = `Conventions in the hub database:
- Money columns are integer CENTS. Clover timestamps are epoch ms; every *_local column is 'YYYY-MM-DD HH:MM:SS' store-local time.
- v_sales_lines = line items that count as sales (paid, revenue, not refunded/exchanged, not test). net_sales is pre-tax after line AND order-level discounts. sale_date is the local date. qty is units sold.
- v_inventory = active items with on_hand stock (from item_stocks), price and cost.
- orders.payment_state: PAID / OPEN / PARTIALLY_PAID / REFUNDED / PARTIALLY_REFUNDED. payments.result='SUCCESS' for real money; payments.amount includes tax, excludes tip.
- refunds/credits hold money returned. item_categories links items to categories (an item can be in several).
- catalog holds small Clover lists keyed by resource: categories, tags, item_groups, modifier_groups, attributes, tenders, tax_rates, order_types, discounts, roles, devices, opening_hours, merchant. Use json_extract(json,'$.field').
- kv_entries mirrors Cloudflare KV: namespace ttc_ops (cigar meta_<itemId> enrichment: strength/wrapper/binder/filler/vitola/profile, inventory caches, ops:invoices, ops:reorder, planning:*, humidor_log, cigar_requests, online_orders, graveyard_items), ttc_customers (customer humidor/purchase records keyed by phone and cust_<phone>), ttc_locator. value is raw text, usually JSON.
- events holds payloads pushed from Zapier/webhooks (source, received_local, payload JSON).
- Join cigar details to sales: kv_entries k ON k.namespace='ttc_ops' AND k.key = 'meta_' || item_id, then json_extract(k.value,'$.strength').`;

// ---------------------------------------------------------------------------

async function salesSummary(env, args) {
  const db = env.DB;
  const { start, end } = range(env, args, 7);
  const groupBy = args.group_by || "day";
  const limit = Math.min(Number(args.limit) || 50, 500);
  const timeKeys = {
    day: "substr(created_local,1,10)",
    week: "date(substr(created_local,1,10),'weekday 0','-6 days')",
    month: "substr(created_local,1,7)",
    weekday: "strftime('%w', substr(created_local,1,10))",
    hour: "substr(created_local,12,2)",
  };
  let lineSql;
  if (timeKeys[groupBy]) {
    lineSql = `SELECT ${timeKeys[groupBy]} AS k, NULL AS label, COUNT(DISTINCT order_id) orders, SUM(qty) units, SUM(net_sales) net, SUM(line_discount+order_discount_alloc) disc
      FROM v_sales_lines WHERE sale_date BETWEEN ?1 AND ?2 GROUP BY k ORDER BY k`;
  } else {
    const joins = {
      item: ["COALESCE(s.item_id, s.name)", "MAX(s.name)", ""],
      category: ["COALESCE(c.category_name,'(uncategorized)')", "NULL", "LEFT JOIN item_categories c ON c.item_id = s.item_id"],
      employee: ["COALESCE(s.employee_id,'(none)')", "MAX(e.name)", "LEFT JOIN employees e ON e.id = s.employee_id"],
      customer: ["COALESCE(s.customer_id,'(walk-in)')", "MAX(cu.full_name)", "LEFT JOIN customers cu ON cu.id = s.customer_id"],
      order_type: ["COALESCE(s.order_type,'(none)')", "NULL", ""],
    };
    if (groupBy === "tender") {
      const rows = await all(db, `SELECT COALESCE(tender_label,'(unknown)') k, COUNT(*) payments, SUM(amount) amount, SUM(tax_amount) tax, SUM(tip_amount) tips
        FROM payments WHERE result='SUCCESS' AND substr(created_local,1,10) BETWEEN ?1 AND ?2 GROUP BY k ORDER BY amount DESC`, start, end);
      return { start, end, group_by: groupBy, rows: rows.map((r) => ({ tender: r.k, payments: r.payments, amount: $(r.amount), tax: $(r.tax), tips: $(r.tips) })) };
    }
    const j = joins[groupBy];
    if (!j) throw new Error("group_by must be one of day, week, month, weekday, hour, item, category, employee, customer, order_type, tender");
    lineSql = `SELECT ${j[0]} AS k, ${j[1]} AS label, COUNT(DISTINCT s.order_id) orders, SUM(s.qty) units, SUM(s.net_sales) net, SUM(s.line_discount+s.order_discount_alloc) disc
      FROM v_sales_lines s ${j[2]} WHERE s.sale_date BETWEEN ?1 AND ?2 GROUP BY k ORDER BY ${args.sort === "units" ? "units" : "net"} DESC LIMIT ${limit}`;
  }
  const [lines, pays, refs, totals] = await Promise.all([
    all(db, lineSql, start, end),
    timeKeys[groupBy] ? all(db, `SELECT ${timeKeys[groupBy]} k, SUM(amount) collected, SUM(tax_amount) tax, SUM(tip_amount) tips FROM payments WHERE result='SUCCESS' AND substr(created_local,1,10) BETWEEN ?1 AND ?2 GROUP BY k`, start, end) : [],
    timeKeys[groupBy] ? all(db, `SELECT ${timeKeys[groupBy]} k, SUM(amount) refunded FROM refunds WHERE substr(created_local,1,10) BETWEEN ?1 AND ?2 GROUP BY k`, start, end) : [],
    all(db, `SELECT COUNT(DISTINCT order_id) orders, SUM(qty) units, SUM(net_sales) net, SUM(line_discount+order_discount_alloc) disc FROM v_sales_lines WHERE sale_date BETWEEN ?1 AND ?2`, start, end),
  ]);
  const pMap = new Map(pays.map((p) => [p.k, p]));
  const rMap = new Map(refs.map((r) => [r.k, r]));
  const rows = lines.map((r) => {
    const out = { [groupBy]: groupBy === "weekday" ? WEEKDAYS[Number(r.k)] : r.k };
    if (r.label) out.name = r.label;
    Object.assign(out, { orders: r.orders, units: r.units, net_sales: $(r.net), discounts: $(r.disc), avg_ticket: r.orders ? $(r.net / r.orders) : null });
    const p = pMap.get(r.k);
    if (p) Object.assign(out, { collected: $(p.collected), tax: $(p.tax), tips: $(p.tips) });
    const rf = rMap.get(r.k);
    if (rf) out.refunded = $(rf.refunded);
    return out;
  });
  const t = totals[0] || {};
  return {
    start, end, group_by: groupBy,
    totals: { orders: t.orders || 0, units: t.units || 0, net_sales: $(t.net || 0), discounts: $(t.disc || 0), avg_ticket: t.orders ? $(t.net / t.orders) : null },
    note: "net_sales is pre-tax item sales after discounts; collected = successful payments incl. tax, excl. tips.",
    rows,
  };
}

async function velocityRows(env, { lookback = 30, search, category, includeHidden, extraWhere = "", order = "i.name", limit = 200 }) {
  const t = today(env);
  const since = addDays(t, -(lookback - 1));
  const since90 = addDays(t, -89);
  const where = ["1=1"];
  const binds = [since, since90];
  if (search) { binds.push(`%${search}%`); where.push(`(i.name LIKE ?${binds.length} OR i.code LIKE ?${binds.length} OR i.sku LIKE ?${binds.length})`); }
  if (category) { binds.push(`%${category}%`); where.push(`i.category_names LIKE ?${binds.length}`); }
  if (!includeHidden) where.push("COALESCE(i.hidden,0) = 0");
  const sql = `WITH v AS (
      SELECT item_id, SUM(CASE WHEN sale_date >= ?1 THEN qty ELSE 0 END) u_lb, SUM(qty) u90,
             SUM(CASE WHEN sale_date >= ?1 THEN net_sales ELSE 0 END) rev_lb
      FROM v_sales_lines WHERE sale_date >= ?2 GROUP BY item_id),
    ls AS (SELECT item_id, MAX(created_local) last_sold FROM line_items WHERE counts_as_sale = 1 GROUP BY item_id)
    SELECT * FROM (
      SELECT i.id, i.name, i.category_names, i.code, i.price, i.cost, i.on_hand, i.auto_manage,
             COALESCE(v.u_lb,0) u_lb, COALESCE(v.u90,0) u90, COALESCE(v.rev_lb,0) rev_lb, ls.last_sold,
             CASE WHEN COALESCE(v.u_lb,0) > 0 THEN i.on_hand / (v.u_lb * 1.0 / ${lookback}) END days_cover
      FROM v_inventory i LEFT JOIN v ON v.item_id = i.id LEFT JOIN ls ON ls.item_id = i.id
      WHERE ${where.join(" AND ")}) i
    WHERE 1=1 ${extraWhere} ORDER BY ${order} LIMIT ${Math.min(Number(limit) || 200, 1000)}`;
  return all(env.DB, sql, ...binds);
}

const invOut = (r, lookback) => ({
  id: r.id, name: r.name, category: r.category_names, code: r.code, on_hand: r.on_hand,
  price: $(r.price), cost: $(r.cost), [`units_sold_${lookback}d`]: r.u_lb, units_sold_90d: r.u90,
  [`net_sales_${lookback}d`]: $(r.rev_lb), last_sold: r.last_sold,
  days_of_cover: r.days_cover == null ? null : Math.round(r.days_cover),
  stock_tracked: r.auto_manage === 1,
});

async function inventory(env, args) {
  let extra = "";
  if (args.low_stock_only) {
    const th = Number(args.threshold ?? 2);
    const doc = Number(args.max_days_of_cover ?? 14);
    extra = `AND (i.on_hand <= ${th} OR (i.days_cover IS NOT NULL AND i.days_cover <= ${doc}))`;
  }
  const rows = await velocityRows(env, { lookback: 30, search: args.search, category: args.category, includeHidden: args.include_hidden, extraWhere: extra, order: args.low_stock_only ? "i.days_cover IS NULL, i.days_cover, i.u90 DESC" : "i.name", limit: args.limit });
  return { as_of: await freshness(env), count: rows.length, items: rows.map((r) => invOut(r, 30)) };
}

async function reorder(env, args) {
  const lookback = Math.max(7, Math.min(Number(args.lookback_days) || 60, 365));
  const target = Number(args.target_days_of_stock) || 30;
  const lead = Number(args.lead_time_days) || 7;
  const rows = await velocityRows(env, { lookback, category: args.category, search: args.search, extraWhere: "AND i.u_lb > 0", order: "i.days_cover", limit: 1000 });
  const out = [];
  for (const r of rows) {
    const rate = r.u_lb / lookback;
    const need = Math.ceil(rate * (target + lead) - Math.max(r.on_hand || 0, 0));
    if (need > 0) out.push({ ...invOut(r, lookback), daily_rate: Math.round(rate * 100) / 100, suggested_order_qty: need, est_cost: $(need * (r.cost || 0)) });
    if (out.length >= (Number(args.limit) || 100)) break;
  }
  return { method: `rate = units sold in last ${lookback}d / ${lookback}; order = rate × (${target} target + ${lead} lead days) − on hand`, as_of: await freshness(env), suggestions: out };
}

async function slowMovers(env, args) {
  const days = Number(args.days) || 90;
  const cutoff = addDays(today(env), -days);
  const rows = await velocityRows(env, { lookback: 30, category: args.category, extraWhere: `AND i.on_hand > 0 AND (i.last_sold IS NULL OR i.last_sold < '${cutoff}')`, order: "i.on_hand * COALESCE(i.cost, i.price, 0) DESC", limit: args.limit || 100 });
  const items = rows.map((r) => ({ ...invOut(r, 30), stock_value_at_cost: $(r.on_hand * (r.cost || 0)), stock_value_at_retail: $(r.on_hand * (r.price || 0)) }));
  return { no_sales_since: cutoff, count: items.length, total_value_at_cost: Math.round(items.reduce((a, i) => a + (i.stock_value_at_cost || 0), 0) * 100) / 100, items };
}

async function customerLookup(env, args) {
  const q = String(args.query || "").trim();
  if (!q) throw new Error("query is required (name, phone or email)");
  const db = env.DB;
  const d = normPhone(q);
  let rows;
  if (d.length >= 4 && /^[\d\s()+.-]+$/.test(q)) rows = await all(db, "SELECT * FROM customers WHERE phones LIKE ?1 LIMIT 10", `%${d}%`);
  else rows = await all(db, "SELECT * FROM customers WHERE full_name LIKE ?1 OR emails LIKE ?1 LIMIT 10", `%${q}%`);
  const out = [];
  for (const c of rows.slice(0, Number(args.limit) || 5)) {
    const [stats] = await all(db, `SELECT COUNT(*) orders, SUM(total) spent, MIN(created_local) first_visit, MAX(created_local) last_visit FROM orders WHERE customer_id = ?1 AND payment_state IN ('PAID','PARTIALLY_REFUNDED')`, c.id);
    const top = await all(db, `SELECT name, SUM(qty) units, SUM(net_sales) net, MAX(created_local) last FROM v_sales_lines WHERE customer_id = ?1 GROUP BY COALESCE(item_id,name) ORDER BY units DESC LIMIT 15`, c.id);
    const recent = await all(db, `SELECT id, created_local, total, payment_state FROM orders WHERE customer_id = ?1 ORDER BY created_time DESC LIMIT 10`, c.id);
    let kv = null;
    if (env.CUSTOMERS_KV && c.phone) {
      for (const key of [c.phone, `cust_${c.phone}`, `1${c.phone}`, `+1${c.phone}`]) {
        const v = await env.CUSTOMERS_KV.get(key);
        if (v) { kv = { key, value: tryJson(v) }; break; }
      }
    }
    out.push({
      id: c.id, name: c.full_name, phone: c.phones, email: c.emails, marketing_allowed: c.marketing_allowed === 1,
      customer_since: c.customer_since_local, orders: stats.orders, lifetime_spend: $(stats.spent || 0),
      first_visit: stats.first_visit, last_visit: stats.last_visit,
      favorite_items: top.map((t) => ({ name: t.name, units: t.units, net: $(t.net), last: t.last })),
      recent_orders: recent.map((o) => ({ ...o, total: $(o.total) })),
      ttc_customers_kv: kv,
    });
  }
  return { matches: rows.length, customers: out };
}

function tryJson(v) { try { return JSON.parse(v); } catch { return v; } }

async function freshness(env) {
  const rows = await all(env.DB, "SELECT resource, last_success, last_error FROM sync_state WHERE resource IN ('orders','item_stocks','items')");
  const o = {};
  for (const r of rows) o[r.resource] = r.last_success ? toLocal(r.last_success, tzOf(env)) : "never";
  return o;
}

async function snapshot(env) {
  const t = today(env);
  const lastWeek = addDays(t, -7);
  const monthStart = t.slice(0, 8) + "01";
  const dayOfMonth = Number(t.slice(8, 10));
  const prevMonthStart = addDays(monthStart, -1).slice(0, 8) + "01";
  const prevMonthSameDay = addDays(prevMonthStart, dayOfMonth - 1);
  const q = (a, b) => all(env.DB, "SELECT COUNT(DISTINCT order_id) orders, SUM(qty) units, SUM(net_sales) net FROM v_sales_lines WHERE sale_date BETWEEN ?1 AND ?2", a, b).then((r) => ({ orders: r[0].orders || 0, units: r[0].units || 0, net_sales: $(r[0].net || 0) }));
  const [today_, sameDayLastWeek, last7, prev7, mtd, prevMtd, top, oos] = await Promise.all([
    q(t, t), q(lastWeek, lastWeek), q(addDays(t, -6), t), q(addDays(t, -13), addDays(t, -7)),
    q(monthStart, t), q(prevMonthStart, prevMonthSameDay),
    all(env.DB, "SELECT name, SUM(qty) units, SUM(net_sales) net FROM v_sales_lines WHERE sale_date >= ?1 GROUP BY COALESCE(item_id,name) ORDER BY net DESC LIMIT 10", addDays(t, -29)),
    all(env.DB, `SELECT COUNT(*) n FROM v_inventory i WHERE i.on_hand <= 0 AND i.id IN (SELECT item_id FROM v_sales_lines WHERE sale_date >= ?1)`, addDays(t, -29)),
  ]);
  return {
    store_date: t,
    today: today_, same_day_last_week: sameDayLastWeek,
    last_7_days: last7, prior_7_days: prev7,
    month_to_date: mtd, last_month_same_period: prevMtd,
    top_items_30d: top.map((r) => ({ name: r.name, units: r.units, net_sales: $(r.net) })),
    sold_in_last_30d_but_out_of_stock: oos[0].n,
    data_as_of: await freshness(env),
  };
}

async function sqlQuery(env, args) {
  const db = dbFor(env, args.database || "hub");
  const { sql, wrappable } = readOnlySql(args.sql);
  const max = Math.min(Number(args.max_rows) || 500, 5000);
  const finalSql = wrappable ? `SELECT * FROM (${sql}) LIMIT ${max + 1}` : sql;
  const res = await db.prepare(finalSql).all();
  const rows = res.results || [];
  return { rows: rows.slice(0, max), truncated: rows.length > max, row_count: Math.min(rows.length, max) };
}

async function describe(env, args) {
  const name = args.database || "hub";
  const db = dbFor(env, name);
  const objs = await all(db, "SELECT type, name, sql FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type, name");
  const tables = [];
  for (const o of objs) {
    const cols = await all(db, `SELECT name, type FROM pragma_table_info(?1)`, o.name);
    let rows = null;
    if (o.type === "table") rows = (await all(db, `SELECT COUNT(*) n FROM "${o.name.replace(/"/g, '""')}"`))[0].n;
    tables.push({ name: o.name, type: o.type, rows, columns: cols.map((c) => `${c.name}${c.type ? " " + c.type : ""}`).join(", ") });
  }
  return {
    database: name,
    other_databases: Object.fromEntries(Object.entries(DATABASES).filter(([, d]) => env[d.binding]).map(([k, d]) => [k, d.about])),
    notes: name === "hub" ? HUB_NOTES : undefined,
    tables,
  };
}

function kvBinding(env, ns) {
  const found = kvNamespaces(env).find(([n]) => n === ns);
  if (!found) throw new Error(`namespace must be one of: ${kvNamespaces(env).map(([n]) => n).join(", ")}`);
  return found[1];
}

async function kvList(env, args) {
  const ns = kvBinding(env, args.namespace);
  const r = await ns.list({ prefix: args.prefix || undefined, limit: Math.min(Number(args.limit) || 200, 1000), cursor: args.cursor || undefined });
  return { keys: r.keys.map((k) => k.name), next_cursor: r.list_complete ? null : r.cursor };
}

async function kvGet(env, args) {
  const ns = kvBinding(env, args.namespace);
  const v = await ns.get(args.key, "text");
  if (v == null) return { found: false };
  const max = 150_000;
  return { found: true, size: v.length, truncated: v.length > max, value: v.length > max ? v.slice(0, max) : tryJson(v) };
}

async function cloverGet(env, args) {
  const path = String(args.path || "");
  if (path && (!path.startsWith("/") || path.includes(".."))) throw new Error("path must be relative to the merchant and start with '/', e.g. /orders/ABC123 or /items");
  const data = await new Clover(env).get(path, args.params || {});
  const text = JSON.stringify(data);
  return text.length > 200_000 ? { truncated: true, json_prefix: text.slice(0, 200_000) } : data;
}

async function syncStatus(env) {
  const rows = await all(env.DB, "SELECT * FROM sync_state WHERE resource <> '_schema' ORDER BY resource");
  const tz = tzOf(env);
  const known = new Map(rows.map((r) => [r.resource, r]));
  const counts = {};
  for (const t of ["orders", "line_items", "payments", "refunds", "items", "item_stocks", "customers", "employees", "shifts", "cash_events", "catalog", "kv_entries", "events"]) {
    counts[t] = (await all(env.DB, `SELECT COUNT(*) n FROM ${t}`))[0].n;
  }
  return {
    clover_configured: !!(env.CLOVER_TOKEN && env.CLOVER_MID),
    row_counts: counts,
    resources: RESOURCES.map((r) => {
      const s = known.get(r.name);
      if (!s) return { resource: r.name, status: "not started" };
      return {
        resource: r.name, mode: r.mode,
        last_caught_up: s.last_success ? toLocal(s.last_success, tz) : null,
        synced_through: r.mode === "window" && s.cursor ? toLocal(s.cursor, tz) : undefined,
        in_progress: s.phase === "running" || s.window_end != null || undefined,
        rows_synced_total: s.rows_synced, error: s.last_error || undefined,
        retry_after: s.next_try && s.next_try > Date.now() ? toLocal(s.next_try, tz) : undefined,
      };
    }),
  };
}

// ---------------------------------------------------------------------------

const S = (props, required = []) => ({ type: "object", properties: props, required, additionalProperties: false });
const str = (description, extra = {}) => ({ type: "string", description, ...extra });
const num = (description) => ({ type: "number", description });
const bool_ = (description) => ({ type: "boolean", description });
const DATE = "YYYY-MM-DD, store-local";

export const TOOLS = [
  { name: "business_snapshot", description: "Start here. Today vs same day last week, last 7 days vs prior 7, month-to-date vs last month, top items, out-of-stock bestsellers, and how fresh the data is.",
    inputSchema: S({}), run: snapshot },
  { name: "sales_summary", description: "Sales for a date range grouped by day, week, month, weekday, hour, item, category, employee, customer, order_type or tender. Returns orders, units, net sales (pre-tax, after discounts), discounts, average ticket, and for time groupings also collected payments, tax, tips and refunds.",
    inputSchema: S({ start: str(`Start date ${DATE}. Default: 6 days before end.`), end: str(`End date inclusive ${DATE}. Default: today.`),
      group_by: str("Grouping", { enum: ["day", "week", "month", "weekday", "hour", "item", "category", "employee", "customer", "order_type", "tender"] }),
      sort: str("For non-time groupings", { enum: ["net", "units"] }), limit: num("Max rows for non-time groupings (default 50)") }), run: salesSummary },
  { name: "inventory", description: "Current Clover stock for items with price, cost, units sold in the last 30/90 days, last sale and days of stock cover. Use low_stock_only to see what's running out.",
    inputSchema: S({ search: str("Name, UPC or SKU contains"), category: str("Category name contains"), low_stock_only: bool_("Only items at/below threshold or with few days of cover"),
      threshold: num("Low stock unit threshold (default 2)"), max_days_of_cover: num("Low-stock if days of cover ≤ this (default 14)"), include_hidden: bool_("Include hidden items"), limit: num("Max rows (default 200)") }), run: inventory },
  { name: "reorder_suggestions", description: "Suggested order quantities from recent sales velocity, target days of stock and supplier lead time, most urgent first, with estimated cost.",
    inputSchema: S({ lookback_days: num("Sales window for velocity (default 60)"), target_days_of_stock: num("Stock to have after reorder (default 30)"), lead_time_days: num("Supplier lead time (default 7)"),
      category: str("Category name contains"), search: str("Item name contains"), limit: num("Max rows (default 100)") }), run: reorder },
  { name: "slow_movers", description: "Items in stock with no sales in N days (dead stock), ranked by money tied up at cost.",
    inputSchema: S({ days: num("No sales in this many days (default 90)"), category: str("Category name contains"), limit: num("Max rows (default 100)") }), run: slowMovers },
  { name: "customer_lookup", description: "Find Clover customers by name, phone or email; returns lifetime spend, visits, favorite items, recent orders and their TTC customer-humidor record from KV.",
    inputSchema: S({ query: str("Name, phone or email (partial ok)"), limit: num("Max customers (default 5)") }, ["query"]), run: customerLookup },
  { name: "sql_query", description: "Run one read-only SQL query (SQLite dialect) against a database. Call describe_data first to see tables and conventions. Databases: hub (Clover + KV mirror, default), cashflow, schedule, legacy_clover.",
    inputSchema: S({ sql: str("SELECT/WITH query"), database: str("Which database", { enum: Object.keys(DATABASES) }), max_rows: num("Default 500, max 5000") }, ["sql"]), run: sqlQuery },
  { name: "describe_data", description: "List tables, views, columns and row counts of a database, plus the hub's conventions (cents, local time, which view to use for sales).",
    inputSchema: S({ database: str("Which database (default hub)", { enum: Object.keys(DATABASES) }) }), run: describe },
  { name: "kv_list", description: "List live keys in a Cloudflare KV namespace (ttc_ops, ttc_customers, ttc_locator).",
    inputSchema: S({ namespace: str("Namespace", { enum: ["ttc_ops", "ttc_customers", "ttc_locator"] }), prefix: str("Key prefix"), limit: num("Default 200"), cursor: str("From a previous call") }, ["namespace"]), run: kvList },
  { name: "kv_get", description: "Read the live value of one KV key.",
    inputSchema: S({ namespace: str("Namespace", { enum: ["ttc_ops", "ttc_customers", "ttc_locator"] }), key: str("Key") }, ["namespace", "key"]), run: kvGet },
  { name: "clover_api_get", description: "Live read-only GET against the Clover REST API for this merchant, for anything not in the mirror or when you need up-to-the-second data. path is relative to /v3/merchants/{mId}, e.g. /orders/ID?expand=lineItems or /items. params are query params (values may be arrays for repeated keys like filter).",
    inputSchema: S({ path: str("e.g. /orders, /items/ABC, /customers, '' for the merchant"), params: { type: "object", description: "Query params, e.g. {\"limit\":10,\"expand\":\"lineItems\",\"filter\":[\"createdTime>=1700000000000\"]}" } }, ["path"]), run: cloverGet },
  { name: "sync_status", description: "How fresh each mirrored dataset is, row counts, and any sync errors (e.g. missing Clover permissions).",
    inputSchema: S({}), run: syncStatus },
  { name: "sync_now", description: "Pull the latest sales, payments and stock levels from Clover right now (the mirror normally refreshes every 5 minutes). Pass resources to refresh something else, e.g. [\"items\",\"customers\",\"kv_mirror\"].",
    inputSchema: S({ budget: num("Max API pages this call (default 25)"), resources: { type: "array", items: { type: "string" }, description: "Only these resources, e.g. [\"orders\",\"item_stocks\"]" } }),
    run: (env, a) => runSync(env, { budget: a.budget, only: a.resources?.length ? a.resources : ["orders", "payments", "refunds", "credits", "cash_events", "item_stocks"], force: true }) },
];
