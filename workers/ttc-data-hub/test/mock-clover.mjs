// Fake Clover API for local end-to-end testing: node test/mock-clover.mjs 8789
import http from "node:http";
const port = Number(process.argv[2] || 8789);
const DAY = 86400000;
const now = Date.now();
let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const cats = [{ id: "C1", name: "Cigars" }, { id: "C2", name: "Pipe Tobacco" }, { id: "C3", name: "Accessories" }];
const items = Array.from({ length: 40 }, (_, i) => ({
  id: "I" + i, name: (i < 25 ? "Cigar " : i < 33 ? "Pipe Blend " : "Cutter ") + i, price: 500 + i * 37, cost: 250 + i * 15,
  priceType: "FIXED", code: "0000" + i, hidden: false, autoManage: true, modifiedTime: now - DAY,
  categories: { elements: [cats[i < 25 ? 0 : i < 33 ? 1 : 2]] }, itemStock: { quantity: (i * 7) % 13, item: { id: "I" + i } },
}));
const customers = Array.from({ length: 30 }, (_, i) => ({ id: "K" + i, firstName: "Cust", lastName: "N" + i, customerSince: now - 400 * DAY,
  phoneNumbers: { elements: [{ phoneNumber: "(570) 555-" + String(1000 + i) }] }, emailAddresses: { elements: [{ emailAddress: `c${i}@x.com` }] }, marketingAllowed: i % 2 === 0 }));
const employees = [{ id: "E1", name: "Owner", roles: { elements: [{ name: "Admin" }] }, isOwner: true }, { id: "E2", name: "Clerk", roles: { elements: [{ name: "Employee" }] } }];
const orders = Array.from({ length: 260 }, (_, n) => {
  const t = now - Math.floor(rnd() * 120 * DAY) - 5 * 60000;
  const lines = Array.from({ length: 1 + Math.floor(rnd() * 4) }, (_, j) => {
    const it = items[Math.floor(rnd() * items.length)];
    return { id: `L${n}_${j}`, item: { id: it.id }, name: it.name, price: it.price, createdTime: t,
      refunded: n % 50 === 0 && j === 0, modifications: { elements: [] },
      discounts: { elements: j === 0 && n % 10 === 0 ? [{ name: "10% off", percentage: 10 }] : [] } };
  });
  const sub = lines.reduce((a, l) => a + l.price, 0);
  const o = { id: "O" + n, createdTime: t, modifiedTime: t + 1000, state: "locked", paymentState: n % 37 === 0 ? "OPEN" : "PAID",
    total: Math.round(sub * 1.06), currency: "USD", employee: { id: n % 2 ? "E1" : "E2" },
    customers: n % 3 === 0 ? { elements: [{ id: "K" + (n % 30) }] } : undefined,
    lineItems: { elements: lines }, discounts: n % 25 === 0 ? { elements: [{ id: "D" + n, name: "$5 off", amount: -500 }] } : undefined,
    payments: { elements: [{ id: "P" + n, amount: Math.round(sub * 1.06), taxAmount: Math.round(sub * 0.06), tipAmount: 0, result: "SUCCESS",
      createdTime: t, modifiedTime: t + 1000, tender: { id: "T1", label: n % 4 ? "Credit Card" : "Cash" } }] } };
  return o;
});
const payments = orders.flatMap((o) => o.payments.elements.map((p) => ({ ...p, order: { id: o.id } })));
const lists = {
  "/orders": orders, "/payments": payments, "/refunds": [], "/credits": [], "/cash_events": [],
  "/items": items, "/item_stocks": items.map((i) => ({ item: { id: i.id }, quantity: i.itemStock.quantity })),
  "/customers": customers, "/employees": employees, "/categories": cats, "/tags": [], "/item_groups": [], "/modifier_groups": [],
  "/attributes": [], "/tenders": [{ id: "T1", label: "Credit Card" }], "/tax_rates": [{ id: "TX", name: "PA Sales", rate: 600000 }],
  "/order_types": [], "/discounts": [], "/roles": [], "/devices": [], "/opening_hours": [],
};
const base = "/v3/merchants/MOCKMID";
http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const send = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (req.headers.authorization !== "Bearer test-token") return send(401, { message: "unauthorized" });
  if (!u.pathname.startsWith(base)) return send(404, {});
  const path = u.pathname.slice(base.length);
  if (path === "") return send(200, { id: "MOCKMID", name: "Mock Tobacco Center" });
  if (path === "/orders" && (u.searchParams.get("expand") || "").includes("payments.tender")) return send(400, { message: "bad expand" });
  if (path.startsWith("/orders/")) return send(200, orders.find((o) => o.id === path.slice(8)) || {});
  let list = lists[path];
  if (!list) return send(404, { message: "Not found" });
  for (const f of u.searchParams.getAll("filter")) {
    const m = f.match(/^(\w+)(>=|<)(\d+)$/); if (!m) return send(400, { message: "bad filter " + f });
    list = list.filter((x) => m[2] === ">=" ? (x[m[1]] ?? 0) >= +m[3] : (x[m[1]] ?? 0) < +m[3]);
  }
  const off = +(u.searchParams.get("offset") || 0), lim = +(u.searchParams.get("limit") || 100);
  send(200, { elements: list.slice(off, off + lim) });
}).listen(port, () => console.log("mock clover on", port));
