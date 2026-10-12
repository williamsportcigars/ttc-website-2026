// Pure functions that turn Clover API objects into flat table rows.
// No I/O here so they can be unit tested with plain node.

const formatters = new Map();

// epoch ms -> 'YYYY-MM-DD HH:MM:SS' in the given IANA timezone.
export function toLocal(ms, tz) {
  if (ms == null || !Number.isFinite(Number(ms))) return null;
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    });
    formatters.set(tz, f);
  }
  const p = {};
  for (const part of f.formatToParts(new Date(Number(ms)))) p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

export const elements = (x) => (x && Array.isArray(x.elements) ? x.elements : Array.isArray(x) ? x : []);
const bool = (v) => (v == null ? null : v ? 1 : 0);
const digits = (s) => (s ? String(s).replace(/\D/g, "") : "");
// Keep the last 10 digits so "+1 (570) 555-1234" and "5705551234" match.
export const normPhone = (s) => { const d = digits(s); return d.length > 10 ? d.slice(-10) : d; };

function stripKeys(obj, keys) {
  const out = {};
  for (const k of Object.keys(obj || {})) if (!keys.includes(k)) out[k] = obj[k];
  return out;
}

export function lineAmounts(li) {
  const perUnit = li.unitQty != null && li.unitQty > 0;
  const qty = perUnit ? li.unitQty / 1000 : 1;
  const price = li.price || 0;
  const base = perUnit ? Math.round(price * qty) : price;
  let mods = 0;
  for (const m of elements(li.modifications)) mods += (m.amount || 0) * (m.quantity || 1);
  if (perUnit) mods = Math.round(mods * qty);
  let disc = 0;
  for (const d of elements(li.discounts)) {
    if (d.amount != null) disc += Math.abs(d.amount);
    else if (d.percentage != null) disc += Math.round(((base + mods) * d.percentage) / 100);
  }
  return { qty, base, mods, disc, net: base + mods - disc };
}

export function countsAsSale(li) {
  return li.isRevenue !== false && !li.refunded && !li.exchanged;
}

// Spread order-level discounts over the sale lines in proportion to their net.
function allocate(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!total || sum <= 0) return weights.map(() => 0);
  const out = weights.map((w) => Math.floor((total * w) / sum));
  let rem = total - out.reduce((a, b) => a + b, 0);
  for (let i = 0; rem > 0 && i < out.length; i++) if (weights[i] > 0) { out[i]++; rem--; }
  return out;
}

export function mapOrder(o, tz, syncedAt) {
  const rawLines = elements(o.lineItems);
  const lines = rawLines.map((li) => ({ li, a: lineAmounts(li), sale: countsAsSale(li) }));
  const saleNet = lines.map((x) => (x.sale ? Math.max(x.a.net, 0) : 0));
  const saleSubtotal = saleNet.reduce((a, b) => a + b, 0);

  const discounts = elements(o.discounts).map((d) => {
    const applied = d.amount != null ? Math.abs(d.amount)
      : d.percentage != null ? Math.round((saleSubtotal * d.percentage) / 100) : 0;
    return {
      id: d.id || `${o.id}:${d.name}`, order_id: o.id, name: d.name ?? null,
      amount: d.amount ?? null, percentage: d.percentage ?? null,
      applied: Math.min(applied, saleSubtotal), json: JSON.stringify(d),
    };
  });
  const orderDisc = discounts.reduce((a, d) => a + d.applied, 0);
  const alloc = allocate(orderDisc, saleNet);

  const lineRows = lines.map(({ li, a, sale }, i) => ({
    id: li.id, order_id: o.id, item_id: li.item?.id ?? null, name: li.name ?? null,
    alternate_name: li.alternateName ?? null, item_code: li.itemCode ?? null,
    price: li.price ?? 0, unit_qty: a.qty, unit_name: li.unitName ?? null,
    base_amount: a.base, modifications_total: a.mods, line_discount: a.disc,
    order_discount_alloc: alloc[i], net_sales: a.net - alloc[i],
    is_revenue: bool(li.isRevenue !== false), refunded: bool(li.refunded), exchanged: bool(li.exchanged),
    counts_as_sale: sale ? 1 : 0,
    created_time: li.createdTime ?? o.createdTime ?? null,
    created_local: toLocal(li.createdTime ?? o.createdTime, tz),
    note: li.note ?? null,
    modifications: JSON.stringify(elements(li.modifications).map((m) => ({ name: m.name, amount: m.amount, modifier: m.modifier?.id }))),
    discounts: JSON.stringify(elements(li.discounts).map((d) => ({ name: d.name, amount: d.amount, percentage: d.percentage }))),
  }));

  const lineDisc = lines.reduce((a, x) => a + (x.sale ? x.a.disc : 0), 0);
  const order = {
    id: o.id, created_time: o.createdTime ?? null, created_local: toLocal(o.createdTime, tz),
    modified_time: o.modifiedTime ?? null, state: o.state ?? null, payment_state: o.paymentState ?? null,
    total: o.total ?? null, currency: o.currency ?? null, title: o.title ?? null, note: o.note ?? null,
    employee_id: o.employee?.id ?? null, customer_id: elements(o.customers)[0]?.id ?? null,
    order_type_id: o.orderType?.id ?? null, order_type: o.orderType?.label ?? null,
    device_id: o.device?.id ?? null, manual_transaction: bool(o.manualTransaction),
    test_mode: bool(o.testMode), tax_removed: bool(o.taxRemoved), line_count: rawLines.length,
    net_sales: lineRows.reduce((a, r) => a + (r.counts_as_sale ? r.net_sales : 0), 0),
    discount_total: lineDisc + orderDisc,
    json: JSON.stringify(stripKeys(o, ["lineItems", "payments", "refunds", "credits", "discounts", "customers"])),
    synced_at: syncedAt,
  };

  const payments = elements(o.payments).map((p) => mapPayment({ ...p, order: p.order || { id: o.id } }, tz, syncedAt));
  const refunds = elements(o.refunds).map((r) => mapRefund({ ...r, orderRef: r.orderRef || { id: o.id } }, tz, syncedAt));
  const credits = elements(o.credits).map((c) => mapCredit({ ...c, orderRef: c.orderRef || { id: o.id } }, tz, syncedAt));
  return { order, lines: lineRows, discounts, payments, refunds, credits };
}

export function mapPayment(p, tz, syncedAt) {
  const ct = p.cardTransaction || {};
  return {
    id: p.id, order_id: p.order?.id ?? null, amount: p.amount ?? 0, tip_amount: p.tipAmount ?? 0,
    tax_amount: p.taxAmount ?? 0, cashback_amount: p.cashbackAmount ?? 0, result: p.result ?? null,
    tender_id: p.tender?.id ?? null, tender_label: p.tender?.label ?? null,
    employee_id: p.employee?.id ?? null, device_id: p.device?.id ?? null,
    card_type: ct.cardType ?? null, card_last4: ct.last4 ?? null, entry_type: ct.entryType ?? null,
    offline: bool(p.offline), created_time: p.createdTime ?? null, created_local: toLocal(p.createdTime, tz),
    modified_time: p.modifiedTime ?? null,
    json: JSON.stringify(stripKeys(p, ["order", "refunds", "lineItemPayments"])), synced_at: syncedAt,
  };
}

export function mapRefund(r, tz, syncedAt) {
  return {
    id: r.id, payment_id: r.payment?.id ?? null, order_id: r.orderRef?.id ?? r.payment?.order?.id ?? null,
    amount: r.amount ?? 0, tax_amount: r.taxAmount ?? 0, tip_amount: r.tipAmount ?? 0,
    employee_id: r.employee?.id ?? null, created_time: r.createdTime ?? null,
    created_local: toLocal(r.createdTime, tz),
    json: JSON.stringify(stripKeys(r, ["payment", "lineItems"])), synced_at: syncedAt,
  };
}

export function mapCredit(c, tz, syncedAt) {
  return {
    id: c.id, order_id: c.orderRef?.id ?? null, amount: c.amount ?? 0, tax_amount: c.taxAmount ?? 0,
    employee_id: c.employee?.id ?? null, tender_label: c.tender?.label ?? null,
    created_time: c.createdTime ?? null, created_local: toLocal(c.createdTime, tz),
    json: JSON.stringify(c), synced_at: syncedAt,
  };
}

export function mapItem(it, syncedAt) {
  const cats = elements(it.categories);
  const stock = it.itemStock || {};
  return {
    row: {
      id: it.id, name: it.name ?? null, alternate_name: it.alternateName ?? null, code: it.code ?? null,
      sku: it.sku ?? null, price: it.price ?? null, price_type: it.priceType ?? null,
      unit_name: it.unitName ?? null, cost: it.cost ?? null, is_revenue: bool(it.isRevenue),
      hidden: bool(it.hidden), available: bool(it.available), auto_manage: bool(it.autoManage),
      default_tax_rates: bool(it.defaultTaxRates), stock_count: it.stockCount ?? null,
      stock_quantity: stock.quantity ?? null,
      category_names: cats.map((c) => c.name).join(", ") || null,
      tag_names: elements(it.tags).map((t) => t.name).join(", ") || null,
      item_group_id: it.itemGroup?.id ?? null, modified_time: it.modifiedTime ?? null,
      deleted: it.deleted ? 1 : 0,
      json: JSON.stringify(stripKeys(it, ["categories", "tags", "itemStock", "modifierGroups"])),
      synced_at: syncedAt,
    },
    categories: cats.map((c) => ({ item_id: it.id, category_id: c.id, category_name: c.name ?? null })),
  };
}

export function mapItemStock(s, syncedAt) {
  return {
    item_id: s.item?.id, quantity: s.quantity ?? null, stock_count: s.stockCount ?? null,
    modified_time: s.modifiedTime ?? null, synced_at: syncedAt,
  };
}

export function mapCustomer(c, tz, syncedAt) {
  const phones = elements(c.phoneNumbers).map((p) => normPhone(p.phoneNumber)).filter(Boolean);
  const emails = elements(c.emailAddresses).map((e) => e.emailAddress).filter(Boolean);
  const full = [c.firstName, c.lastName].filter(Boolean).join(" ").trim();
  return {
    id: c.id, first_name: c.firstName ?? null, last_name: c.lastName ?? null, full_name: full || null,
    phone: phones[0] ?? null, phones: phones.join(",") || null,
    email: emails[0] ?? null, emails: emails.join(",") || null,
    marketing_allowed: bool(c.marketingAllowed), customer_since: c.customerSince ?? null,
    customer_since_local: toLocal(c.customerSince, tz), deleted: 0,
    json: JSON.stringify(stripKeys(c, ["orders", "cards"])), synced_at: syncedAt,
  };
}

export function mapEmployee(e, syncedAt) {
  const roles = elements(e.roles).map((r) => r.name).filter(Boolean);
  return {
    id: e.id, name: e.name ?? null, nickname: e.nickname ?? null, custom_id: e.customId ?? null,
    email: e.email ?? null, role: roles.join(", ") || e.role || null, is_owner: bool(e.isOwner),
    deleted: e.deletedTime ? 1 : 0,
    json: JSON.stringify(stripKeys(e, ["pin", "unhashedPin", "orders", "shifts", "payments"])),
    synced_at: syncedAt,
  };
}

export function mapShift(s, tz, syncedAt) {
  const inT = s.overrideInTime ?? s.inTime ?? null;
  const outT = s.overrideOutTime ?? s.outTime ?? null;
  return {
    id: s.id, employee_id: s.employee?.id ?? null, in_time: inT, in_local: toLocal(inT, tz),
    out_time: outT, out_local: toLocal(outT, tz),
    hours: inT && outT ? Math.round(((outT - inT) / 3600000) * 100) / 100 : null,
    cash_tips_collected: s.cashTipsCollected ?? null, server_banking: bool(s.serverBanking),
    json: JSON.stringify(s), synced_at: syncedAt,
  };
}

export function mapCashEvent(e, tz, syncedAt) {
  const id = [e.timestamp, e.device?.id, e.employee?.id, e.type, e.amountChange].join(":");
  return {
    id, type: e.type ?? null, amount_change: e.amountChange ?? null, timestamp: e.timestamp ?? null,
    local_time: toLocal(e.timestamp, tz), note: e.note ?? null, employee_id: e.employee?.id ?? null,
    device_id: e.device?.id ?? null, json: JSON.stringify(e), synced_at: syncedAt,
  };
}

export function mapCatalog(resource, x, syncedAt) {
  return {
    resource, id: String(x.id ?? x.name ?? JSON.stringify(x).slice(0, 64)),
    name: x.name ?? x.label ?? null, deleted: 0, json: JSON.stringify(x), synced_at: syncedAt,
  };
}
