-- ttc-data-hub D1 schema (database: ttc_hub)
--
-- Money columns are integer CENTS, exactly as Clover returns them.
-- Clover timestamps are epoch MILLISECONDS (UTC). Every time column also has
-- a *_local twin: 'YYYY-MM-DD HH:MM:SS' in the store's timezone
-- (TIMEZONE var, default America/New_York) so date grouping is a substr().
-- Most tables keep a trimmed copy of the Clover object in `json` so any field
-- not promoted to a column is still reachable with json_extract().
--
-- Safe to re-run: everything is IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS sync_state (
  resource      TEXT PRIMARY KEY,
  cursor        INTEGER,          -- window mode: everything before this is synced
  window_end    INTEGER,          -- window mode: end of the window being paged
  page_offset   INTEGER DEFAULT 0,
  phase         TEXT DEFAULT 'idle', -- full mode: idle | running
  run_started   INTEGER,
  last_success  INTEGER,          -- last time the resource was fully caught up
  last_attempt  INTEGER,
  last_error    TEXT,
  next_try      INTEGER,          -- back-off after errors
  rows_synced   INTEGER DEFAULT 0,
  extra         TEXT              -- JSON scratch (kv cursors, chosen expand, ...)
);

CREATE TABLE IF NOT EXISTS orders (
  id                TEXT PRIMARY KEY,
  created_time      INTEGER,
  created_local     TEXT,
  modified_time     INTEGER,
  state             TEXT,     -- open | locked
  payment_state     TEXT,     -- OPEN | PAID | PARTIALLY_PAID | REFUNDED | PARTIALLY_REFUNDED
  total             INTEGER,  -- cents, includes tax
  currency          TEXT,
  title             TEXT,
  note              TEXT,
  employee_id       TEXT,
  customer_id       TEXT,
  order_type_id     TEXT,
  order_type        TEXT,
  device_id         TEXT,
  manual_transaction INTEGER,
  test_mode         INTEGER,
  tax_removed       INTEGER,
  line_count        INTEGER,
  net_sales         INTEGER,  -- sum of line_items.net_sales for revenue lines
  discount_total    INTEGER,  -- line + order level discounts
  json              TEXT,
  synced_at         INTEGER
);
CREATE INDEX IF NOT EXISTS orders_created ON orders(created_local);
CREATE INDEX IF NOT EXISTS orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS orders_employee ON orders(employee_id);

CREATE TABLE IF NOT EXISTS line_items (
  id                   TEXT PRIMARY KEY,
  order_id             TEXT,
  item_id              TEXT,
  name                 TEXT,
  alternate_name       TEXT,
  item_code            TEXT,
  price                INTEGER,  -- unit price, cents
  unit_qty             REAL,     -- quantity (1 unless sold by weight/unit)
  unit_name            TEXT,
  base_amount          INTEGER,  -- price * qty
  modifications_total  INTEGER,
  line_discount        INTEGER,  -- discounts applied to this line
  order_discount_alloc INTEGER,  -- share of order-level discounts
  net_sales            INTEGER,  -- base + mods - line_discount - order_discount_alloc (pre-tax)
  is_revenue           INTEGER,
  refunded             INTEGER,
  exchanged            INTEGER,
  counts_as_sale       INTEGER,  -- 1 when revenue, not refunded, not exchanged
  created_time         INTEGER,
  created_local        TEXT,
  note                 TEXT,
  modifications        TEXT,     -- JSON array
  discounts            TEXT      -- JSON array
);
CREATE INDEX IF NOT EXISTS li_order ON line_items(order_id);
CREATE INDEX IF NOT EXISTS li_item ON line_items(item_id);
CREATE INDEX IF NOT EXISTS li_created ON line_items(created_local);

CREATE TABLE IF NOT EXISTS order_discounts (
  id          TEXT PRIMARY KEY,
  order_id    TEXT,
  name        TEXT,
  amount      INTEGER,   -- cents (negative = off) when fixed
  percentage  REAL,
  applied     INTEGER,   -- cents actually taken off (positive)
  json        TEXT
);
CREATE INDEX IF NOT EXISTS od_order ON order_discounts(order_id);

CREATE TABLE IF NOT EXISTS payments (
  id              TEXT PRIMARY KEY,
  order_id        TEXT,
  amount          INTEGER,  -- cents, includes tax, excludes tip
  tip_amount      INTEGER,
  tax_amount      INTEGER,
  cashback_amount INTEGER,
  result          TEXT,     -- SUCCESS | FAIL | ...
  tender_id       TEXT,
  tender_label    TEXT,
  employee_id     TEXT,
  device_id       TEXT,
  card_type       TEXT,
  card_last4      TEXT,
  entry_type      TEXT,
  offline         INTEGER,
  created_time    INTEGER,
  created_local   TEXT,
  modified_time   INTEGER,
  json            TEXT,
  synced_at       INTEGER
);
CREATE INDEX IF NOT EXISTS pay_order ON payments(order_id);
CREATE INDEX IF NOT EXISTS pay_created ON payments(created_local);

CREATE TABLE IF NOT EXISTS refunds (
  id            TEXT PRIMARY KEY,
  payment_id    TEXT,
  order_id      TEXT,
  amount        INTEGER,
  tax_amount    INTEGER,
  tip_amount    INTEGER,
  employee_id   TEXT,
  created_time  INTEGER,
  created_local TEXT,
  json          TEXT,
  synced_at     INTEGER
);
CREATE INDEX IF NOT EXISTS ref_created ON refunds(created_local);

CREATE TABLE IF NOT EXISTS credits (
  id            TEXT PRIMARY KEY,
  order_id      TEXT,
  amount        INTEGER,
  tax_amount    INTEGER,
  employee_id   TEXT,
  tender_label  TEXT,
  created_time  INTEGER,
  created_local TEXT,
  json          TEXT,
  synced_at     INTEGER
);

CREATE TABLE IF NOT EXISTS items (
  id               TEXT PRIMARY KEY,
  name             TEXT,
  alternate_name   TEXT,
  code             TEXT,     -- UPC / barcode
  sku              TEXT,
  price            INTEGER,  -- cents
  price_type       TEXT,     -- FIXED | VARIABLE | PER_UNIT
  unit_name        TEXT,
  cost             INTEGER,  -- cents
  is_revenue       INTEGER,
  hidden           INTEGER,
  available        INTEGER,
  auto_manage      INTEGER,  -- Clover stock tracking on
  default_tax_rates INTEGER,
  stock_count      INTEGER,
  stock_quantity   REAL,
  category_names   TEXT,     -- comma separated
  tag_names        TEXT,
  item_group_id    TEXT,
  modified_time    INTEGER,
  deleted          INTEGER DEFAULT 0,  -- 1 = no longer returned by Clover
  json             TEXT,
  synced_at        INTEGER
);
CREATE INDEX IF NOT EXISTS items_name ON items(name);
CREATE INDEX IF NOT EXISTS items_code ON items(code);

CREATE TABLE IF NOT EXISTS item_categories (
  item_id       TEXT,
  category_id   TEXT,
  category_name TEXT,
  PRIMARY KEY (item_id, category_id)
);
CREATE INDEX IF NOT EXISTS ic_cat ON item_categories(category_id);

CREATE TABLE IF NOT EXISTS item_stocks (
  item_id       TEXT PRIMARY KEY,
  quantity      REAL,
  stock_count   INTEGER,
  modified_time INTEGER,
  synced_at     INTEGER
);

CREATE TABLE IF NOT EXISTS customers (
  id                TEXT PRIMARY KEY,
  first_name        TEXT,
  last_name         TEXT,
  full_name         TEXT,
  phone             TEXT,     -- first phone, digits only
  phones            TEXT,     -- comma separated, digits only
  email             TEXT,
  emails            TEXT,
  marketing_allowed INTEGER,
  customer_since    INTEGER,
  customer_since_local TEXT,
  deleted           INTEGER DEFAULT 0,
  json              TEXT,
  synced_at         INTEGER
);
CREATE INDEX IF NOT EXISTS cust_phone ON customers(phone);
CREATE INDEX IF NOT EXISTS cust_name ON customers(full_name);

CREATE TABLE IF NOT EXISTS employees (
  id          TEXT PRIMARY KEY,
  name        TEXT,
  nickname    TEXT,
  custom_id   TEXT,
  email       TEXT,
  role        TEXT,
  is_owner    INTEGER,
  deleted     INTEGER DEFAULT 0,
  json        TEXT,
  synced_at   INTEGER
);

CREATE TABLE IF NOT EXISTS shifts (
  id                TEXT PRIMARY KEY,
  employee_id       TEXT,
  in_time           INTEGER,
  in_local          TEXT,
  out_time          INTEGER,
  out_local         TEXT,
  hours             REAL,
  cash_tips_collected INTEGER,
  server_banking    INTEGER,
  json              TEXT,
  synced_at         INTEGER
);

CREATE TABLE IF NOT EXISTS cash_events (
  id            TEXT PRIMARY KEY,   -- synthetic
  type          TEXT,
  amount_change INTEGER,
  timestamp     INTEGER,
  local_time    TEXT,
  note          TEXT,
  employee_id   TEXT,
  device_id     TEXT,
  json          TEXT,
  synced_at     INTEGER
);

-- Small Clover lists: categories, tags, item_groups, modifier_groups,
-- tenders, tax_rates, order_types, discounts, roles, devices,
-- opening_hours, attributes, merchant.
CREATE TABLE IF NOT EXISTS catalog (
  resource   TEXT,
  id         TEXT,
  name       TEXT,
  deleted    INTEGER DEFAULT 0,
  json       TEXT,
  synced_at  INTEGER,
  PRIMARY KEY (resource, id)
);

-- Mirror of the Cloudflare KV namespaces (TTC Ops, TTC_CUSTOMERS, TTC_LOCATOR_KV)
CREATE TABLE IF NOT EXISTS kv_entries (
  namespace  TEXT,
  key        TEXT,
  value      TEXT,     -- raw text (usually JSON); NULL when too large
  size       INTEGER,
  synced_at  INTEGER,
  deleted    INTEGER DEFAULT 0,
  PRIMARY KEY (namespace, key)
);

-- Anything pushed in from Zapier / webhooks via POST /ingest/<source>
CREATE TABLE IF NOT EXISTS events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source        TEXT,
  received_at   INTEGER,
  received_local TEXT,
  payload       TEXT
);
CREATE INDEX IF NOT EXISTS events_source ON events(source, received_at);

-- Line items that count as a sale: paid order, revenue item, not refunded or
-- exchanged, not a test order. sale_date is the store-local date.
DROP VIEW IF EXISTS v_sales_lines;
CREATE VIEW v_sales_lines AS
SELECT li.id, li.order_id, li.item_id, li.name, li.unit_qty AS qty, li.price,
       li.base_amount, li.modifications_total, li.line_discount,
       li.order_discount_alloc, li.net_sales,
       o.created_local, substr(o.created_local, 1, 10) AS sale_date,
       o.employee_id, o.customer_id, o.order_type
FROM line_items li
JOIN orders o ON o.id = li.order_id
WHERE li.counts_as_sale = 1
  AND o.payment_state IN ('PAID', 'PARTIALLY_REFUNDED', 'PARTIALLY_PAID')
  AND COALESCE(o.test_mode, 0) = 0;

DROP VIEW IF EXISTS v_inventory;
CREATE VIEW v_inventory AS
SELECT i.id, i.name, i.code, i.sku, i.category_names, i.price, i.cost,
       COALESCE(s.quantity, i.stock_quantity, i.stock_count) AS on_hand,
       i.auto_manage, i.hidden, i.available, i.price_type, i.modified_time
FROM items i
LEFT JOIN item_stocks s ON s.item_id = i.id
WHERE i.deleted = 0;
