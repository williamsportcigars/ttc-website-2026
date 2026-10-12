import test from "node:test";
import assert from "node:assert/strict";
import { mapOrder, lineAmounts, toLocal, normPhone } from "../src/transform.js";
import { readOnlySql } from "../src/sqlguard.js";

test("order-level discount is fully allocated to sale lines only", () => {
  const o = {
    id: "O1", createdTime: 1760000000000, paymentState: "PAID",
    lineItems: { elements: [
      { id: "a", price: 907, refunded: true },
      { id: "b", price: 796 }, { id: "c", price: 1573 }, { id: "d", price: 1277 },
    ] },
    discounts: { elements: [{ id: "D", amount: -500 }] },
  };
  const m = mapOrder(o, "America/New_York", 1);
  assert.equal(m.lines[0].order_discount_alloc, 0);
  assert.equal(m.lines.reduce((a, l) => a + l.order_discount_alloc, 0), 500);
  assert.equal(m.order.net_sales, 796 + 1573 + 1277 - 500);
});

test("percentage order discount and line discounts", () => {
  const m = mapOrder({ id: "O2", lineItems: { elements: [
    { id: "a", price: 1000, discounts: { elements: [{ percentage: 10 }] } },
    { id: "b", price: 1000, isRevenue: false },
  ] }, discounts: { elements: [{ id: "D", percentage: 50 }] } }, "UTC", 1);
  assert.equal(m.lines[0].line_discount, 100);
  assert.equal(m.lines[0].net_sales, 450);
  assert.equal(m.lines[1].counts_as_sale, 0);
});

test("per-unit (weighed) items use unitQty in thousandths", () => {
  assert.deepEqual(lineAmounts({ price: 2000, unitQty: 1500 }), { qty: 1.5, base: 3000, mods: 0, disc: 0, net: 3000 });
});

test("local time and phones", () => {
  assert.equal(toLocal(Date.UTC(2026, 6, 4, 3, 0, 0), "America/New_York"), "2026-07-03 23:00:00");
  assert.equal(normPhone("+1 (570) 555-1234"), "5705551234");
});

test("sql guard", () => {
  assert.ok(readOnlySql("SELECT replace(name,'a','b'), deleted, created_local FROM items").wrappable);
  assert.ok(readOnlySql("WITH x AS (SELECT 1) SELECT * FROM x;"));
  assert.ok(readOnlySql("PRAGMA table_info(items)"));
  assert.ok(readOnlySql("SELECT 'drop table; delete' AS s"));
  for (const bad of ["DELETE FROM items", "select 1; drop table x", "WITH x AS (SELECT 1) DELETE FROM items",
    "PRAGMA writable_schema=1", "INSERT INTO items VALUES (1)", "SELECT 1 /* */; UPDATE items SET name=1"]) {
    assert.throws(() => readOnlySql(bad), undefined, bad);
  }
});
