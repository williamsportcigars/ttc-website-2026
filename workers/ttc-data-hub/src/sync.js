// Resumable sync engine. Every run (cron or manual) gets a request budget and
// round-robins one page at a time across resources that have work, saving its
// position after every page, so a run that is cut short loses nothing.
//
// Modes:
//   window — incremental on a Clover timestamp field. Pages through
//            [cursor, window_end) and then advances the cursor. Used for
//            orders/payments/etc. Edits (refunds, tip adjusts) bump
//            modifiedTime, so they are picked up again automatically.
//   full   — re-read the whole list every `every` minutes; rows not seen in
//            a complete pass are marked deleted. Used for catalog-style data.
//   single — one GET every `every` minutes (the merchant record).
//   kv     — mirror every key of the bound KV namespaces into kv_entries.

import { Clover, CloverError } from "./clover.js";
import { upsert, deleteIn, loadStates, saveState } from "./db.js";
import * as T from "./transform.js";

const MIN = 60_000;
const DAY = 86_400_000;
const LAG = 2 * MIN; // don't read the last 2 minutes; Clover may still be writing them

const ORDER_EXPANDS = [
  "lineItems,lineItems.modifications,lineItems.discounts,discounts,payments,payments.tender,refunds,credits,customers,employee,orderType",
  "lineItems,lineItems.modifications,lineItems.discounts,discounts,payments,refunds,customers,employee",
  "lineItems,discounts,payments,customers",
];

// startFromNow: window resources whose history already arrives via the orders
// expansion only need to look back a few days.
export const RESOURCES = [
  { name: "orders", mode: "window", path: "/orders", field: "modifiedTime", expands: ORDER_EXPANDS, write: writeOrders },
  { name: "payments", mode: "window", path: "/payments", field: "modifiedTime", startFromNow: 7 * DAY,
    expands: ["tender,cardTransaction,employee,order", "tender,employee,order"], write: rowsWriter("payments", T.mapPayment, true) },
  { name: "refunds", mode: "window", path: "/refunds", field: "createdTime", startFromNow: 14 * DAY,
    expands: ["payment,employee", ""], write: rowsWriter("refunds", T.mapRefund, true) },
  { name: "credits", mode: "window", path: "/credits", field: "createdTime", startFromNow: 14 * DAY,
    expands: ["tender,employee", ""], write: rowsWriter("credits", T.mapCredit, true) },
  { name: "item_stocks", mode: "full", every: 10, path: "/item_stocks", expands: [""], write: writeItemStocks },
  { name: "items", mode: "full", every: 60, path: "/items",
    expands: ["categories,tags,itemStock,itemGroup", "categories,itemStock", ""], write: writeItems },
  { name: "cash_events", mode: "window", path: "/cash_events", field: "timestamp", expands: ["employee,device", ""],
    write: rowsWriter("cash_events", T.mapCashEvent, true) },
  { name: "customers", mode: "full", every: 180, path: "/customers",
    expands: ["emailAddresses,phoneNumbers,addresses,metadata", "emailAddresses,phoneNumbers"], write: writeCustomers },
  { name: "employees", mode: "full", every: 360, path: "/employees", expands: ["roles", ""], write: writeEmployees },
  { name: "shifts", mode: "full", every: 120, path: "/shifts", expands: ["employee", ""], write: rowsWriter("shifts", T.mapShift, true) },
  { name: "merchant", mode: "single", every: 1440, path: "", expands: ["address,owner,openingHours,properties", ""], write: writeMerchant },
  ...[
    ["categories", 360, ""], ["tags", 360, ""], ["item_groups", 360, "attributes"],
    ["modifier_groups", 360, "modifiers"], ["attributes", 360, "options"], ["tenders", 1440, ""],
    ["tax_rates", 1440, ""], ["order_types", 1440, ""], ["discounts", 1440, ""],
    ["roles", 1440, ""], ["devices", 1440, ""], ["opening_hours", 1440, ""],
  ].map(([name, every, expand]) => ({
    name, mode: "full", every, path: "/" + name, expands: expand ? [expand, ""] : [""], catalog: true,
    write: (ctx, els) => upsert(ctx.db, "catalog", els.map((x) => T.mapCatalog(name, x, ctx.syncedAt)), ["resource", "id"]),
  })),
  { name: "kv_mirror", mode: "kv", every: 30 },
];

// ---------- writers: (ctx, elements) -> D1 statements ----------

function rowsWriter(table, map, withTz) {
  return (ctx, els) => upsert(ctx.db, table, els.map((x) => (withTz ? map(x, ctx.tz, ctx.syncedAt) : map(x, ctx.syncedAt))));
}

function writeOrders(ctx, els) {
  const mapped = els.map((o) => T.mapOrder(o, ctx.tz, ctx.syncedAt));
  const ids = mapped.map((m) => m.order.id);
  return [
    ...deleteIn(ctx.db, "line_items", "order_id", ids),
    ...deleteIn(ctx.db, "order_discounts", "order_id", ids),
    ...upsert(ctx.db, "orders", mapped.map((m) => m.order)),
    ...upsert(ctx.db, "line_items", mapped.flatMap((m) => m.lines)),
    ...upsert(ctx.db, "order_discounts", mapped.flatMap((m) => m.discounts)),
    ...upsert(ctx.db, "payments", mapped.flatMap((m) => m.payments)),
    ...upsert(ctx.db, "refunds", mapped.flatMap((m) => m.refunds)),
    ...upsert(ctx.db, "credits", mapped.flatMap((m) => m.credits)),
  ];
}

function writeItems(ctx, els) {
  const mapped = els.map((x) => T.mapItem(x, ctx.syncedAt));
  return [
    ...upsert(ctx.db, "items", mapped.map((m) => m.row)),
    ...deleteIn(ctx.db, "item_categories", "item_id", mapped.map((m) => m.row.id)),
    ...upsert(ctx.db, "item_categories", mapped.flatMap((m) => m.categories), ["item_id", "category_id"]),
  ];
}

function writeItemStocks(ctx, els) {
  return upsert(ctx.db, "item_stocks", els.map((x) => T.mapItemStock(x, ctx.syncedAt)), ["item_id"]);
}

function writeCustomers(ctx, els) {
  return upsert(ctx.db, "customers", els.map((x) => T.mapCustomer(x, ctx.tz, ctx.syncedAt)));
}

function writeEmployees(ctx, els) {
  return upsert(ctx.db, "employees", els.map((x) => T.mapEmployee(x, ctx.syncedAt)));
}

function writeMerchant(ctx, els) {
  return upsert(ctx.db, "catalog", els.map((m) => T.mapCatalog("merchant", m, ctx.syncedAt)), ["resource", "id"]);
}

// After a complete "full" pass, flag rows that Clover no longer returned.
function finalizeFull(ctx, r, runStarted) {
  const db = ctx.db;
  if (r.catalog) return [db.prepare("UPDATE catalog SET deleted = 1 WHERE resource = ? AND synced_at < ?").bind(r.name, runStarted)];
  switch (r.name) {
    case "items": return [db.prepare("UPDATE items SET deleted = 1 WHERE synced_at < ?").bind(runStarted)];
    case "customers": return [db.prepare("UPDATE customers SET deleted = 1 WHERE synced_at < ?").bind(runStarted)];
    case "employees": return [db.prepare("UPDATE employees SET deleted = 1 WHERE synced_at < ?").bind(runStarted)];
    case "item_stocks": return [db.prepare("DELETE FROM item_stocks WHERE synced_at < ?").bind(runStarted)];
    default: return [];
  }
}

// ---------- engine ----------

function initialState(r, env, now) {
  const st = { resource: r.name, page_offset: 0, phase: "idle", rows_synced: 0, extra: {} };
  if (r.mode === "window") {
    const backfill = Date.parse(env.BACKFILL_START || "2020-01-01T00:00:00Z");
    st.cursor = r.startFromNow ? now - r.startFromNow : backfill;
  }
  return st;
}

function hasWork(r, st, now) {
  if (st.next_try && now < st.next_try) return false;
  if (r.mode === "window") return st.window_end != null || st.cursor < now - LAG - 30_000;
  if (st.phase === "running") return true;
  return !st.last_success || now - st.last_success >= r.every * MIN;
}

async function fetchPage(ctx, r, st, params) {
  // Try the richest expansion first; fall back if Clover rejects it (400).
  const tried = st.extra.expandIdx ?? 0;
  for (let i = tried; i < r.expands.length; i++) {
    try {
      const data = await ctx.clover.get(r.path, { ...params, expand: r.expands[i] || undefined });
      st.extra.expandIdx = i;
      return data;
    } catch (e) {
      if (!(e instanceof CloverError) || e.status !== 400 || i === r.expands.length - 1) throw e;
    }
  }
}

async function stepWindow(ctx, r, st, now) {
  const pageSize = ctx.pageSize;
  const baseWindow = (Number(ctx.env.WINDOW_DAYS) || 31) * DAY;
  if (st.window_end == null) {
    st.window_end = Math.min(st.cursor + (st.extra.windowMs || baseWindow), now - LAG);
    st.page_offset = 0;
  }
  const data = await fetchPage(ctx, r, st, {
    filter: [`${r.field}>=${st.cursor}`, `${r.field}<${st.window_end}`],
    limit: pageSize, offset: st.page_offset,
  });
  const els = T.elements(data);
  const stmts = r.write(ctx, els);
  // Empty stretches of history (before the store's first order) grow the
  // window so the backfill doesn't spend requests on them; busy ones reset it.
  if (st.page_offset === 0 && els.length === 0) st.extra.windowMs = Math.min((st.extra.windowMs || baseWindow) * 4, 3650 * DAY);
  else if (els.length >= pageSize) st.extra.windowMs = baseWindow;
  if (st.page_offset === 0 && els.length >= pageSize && st.window_end - st.cursor > baseWindow) {
    // A grown window just hit busy history: shrink it rather than paging deep.
    st.window_end = Math.min(st.cursor + baseWindow, now - LAG);
    return { rows: els.length, stmts };
  }
  if (els.length < pageSize) {
    st.cursor = st.window_end;
    st.window_end = null;
    st.page_offset = 0;
    if (st.cursor >= now - LAG - MIN) st.last_success = now;
  } else {
    st.page_offset += pageSize;
  }
  return { rows: els.length, stmts };
}

async function stepFull(ctx, r, st, now) {
  if (st.phase !== "running") { st.phase = "running"; st.run_started = now; st.page_offset = 0; }
  ctx.syncedAt = st.run_started;
  const pageSize = r.name === "item_stocks" ? 1000 : ctx.pageSize;
  const data = await fetchPage(ctx, r, st, { limit: pageSize, offset: st.page_offset });
  const els = T.elements(data);
  const stmts = r.write(ctx, els);
  if (els.length < pageSize) {
    stmts.push(...finalizeFull(ctx, r, st.run_started));
    st.phase = "idle"; st.page_offset = 0; st.last_success = now;
  } else {
    st.page_offset += pageSize;
  }
  return { rows: els.length, stmts };
}

async function stepSingle(ctx, r, st, now) {
  const data = await fetchPage(ctx, r, st, {});
  st.last_success = now;
  return { rows: 1, stmts: r.write(ctx, [data]) };
}

const KV_MAX_VALUE = 500_000;

export function kvNamespaces(env) {
  return [
    ["ttc_ops", env.OPS_KV], ["ttc_customers", env.CUSTOMERS_KV], ["ttc_locator", env.LOCATOR_KV],
  ].filter(([, b]) => b);
}

async function kvGetMany(ns, keys) {
  try {
    const m = await ns.get(keys, "text"); // bulk get (one operation)
    if (m instanceof Map) return m;
  } catch (_) { /* older runtime: fall back below */ }
  const m = new Map();
  for (const k of keys) m.set(k, await ns.get(k, "text"));
  return m;
}

async function stepKv(ctx, r, st, now) {
  const spaces = kvNamespaces(ctx.env);
  if (st.phase !== "running") { st.phase = "running"; st.run_started = now; st.extra = { ns: 0, cursor: null }; }
  const [name, ns] = spaces[st.extra.ns] || [];
  const stmts = [];
  let rows = 0;
  if (ns) {
    const list = await ns.list({ limit: 100, cursor: st.extra.cursor || undefined });
    const keys = list.keys.map((k) => k.name);
    const values = keys.length ? await kvGetMany(ns, keys) : new Map();
    const out = keys.map((k) => {
      const v = values.get(k);
      const size = v == null ? 0 : v.length;
      return { namespace: name, key: k, value: size > KV_MAX_VALUE ? null : v ?? null, size, synced_at: st.run_started, deleted: 0 };
    });
    stmts.push(...upsert(ctx.db, "kv_entries", out, ["namespace", "key"]));
    rows = out.length;
    if (list.list_complete) { st.extra.ns++; st.extra.cursor = null; } else st.extra.cursor = list.cursor;
  }
  if (st.extra.ns >= spaces.length) {
    stmts.push(ctx.db.prepare("UPDATE kv_entries SET deleted = 1 WHERE synced_at < ?").bind(st.run_started));
    st.phase = "idle"; st.last_success = now; st.extra = {};
  }
  return { rows, stmts };
}

const STEPPERS = { window: stepWindow, full: stepFull, single: stepSingle, kv: stepKv };

export async function runSync(env, opts = {}) {
  const now = Date.now();
  const db = env.DB;
  const budget = Math.max(1, Math.min(Number(opts.budget) || Number(env.MAX_REQUESTS_PER_RUN) || 25, 2000));
  const states = await loadStates(db);
  const log = [];
  let clover = null, cloverErr = null;
  try { clover = new Clover(env); } catch (e) { cloverErr = e.message; }

  let active = RESOURCES.filter((r) => !opts.only || opts.only.includes(r.name));
  if (!clover) active = active.filter((r) => r.mode === "kv");
  if (opts.force) for (const r of active) if (states[r.name]) { states[r.name].next_try = null; if (r.mode !== "window") states[r.name].last_success = null; }

  let used = 0, progressed = true;
  while (used < budget && progressed) {
    progressed = false;
    for (const r of active) {
      if (used >= budget) break;
      const st = (states[r.name] ||= initialState(r, env, now));
      if (!hasWork(r, st, now)) continue;
      used++;
      progressed = true;
      const ctx = { env, db, clover, tz: env.TIMEZONE || "America/New_York", syncedAt: now, pageSize: Math.min(Number(env.PAGE_SIZE) || 100, 1000) };
      st.last_attempt = now;
      try {
        const { rows, stmts } = await STEPPERS[r.mode](ctx, r, st, now);
        st.rows_synced = (st.rows_synced || 0) + rows;
        st.last_error = null;
        st.next_try = null;
        await db.batch([...stmts, saveState(db, st)]);
        log.push({ resource: r.name, rows });
      } catch (e) {
        // 4xx other than 429 means this token can't read it (or the endpoint
        // doesn't exist for this merchant): back off for 6h instead of
        // burning budget every run. Anything else: retry next run.
        const client = e instanceof CloverError && e.status >= 400 && e.status < 500 && e.status !== 429;
        st.last_error = String(e.message || e).slice(0, 500);
        st.next_try = now + (client ? 6 * 60 * MIN : 4 * MIN);
        if (r.mode === "window") { st.window_end = null; st.page_offset = 0; }
        else if (r.mode !== "kv") { st.phase = "idle"; st.page_offset = 0; }
        await db.batch([saveState(db, st)]);
        log.push({ resource: r.name, error: st.last_error });
      }
    }
  }
  const pending = active.filter((r) => hasWork(r, states[r.name] || initialState(r, env, now), now)).map((r) => r.name);
  return { at: new Date(now).toISOString(), requests: used, budget, pending, clover: cloverErr ? `not configured: ${cloverErr}` : "ok", log };
}
