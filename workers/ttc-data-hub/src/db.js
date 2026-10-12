// D1 helpers. Writes go through one JSON parameter per statement
// (INSERT ... SELECT FROM json_each(?)) so a page of 100 orders is a handful
// of statements instead of thousands — that keeps us inside the per-invocation
// query limits on every Workers plan.

const MAX_CHUNK_BYTES = 800_000;

function chunkRows(rows) {
  const chunks = [];
  let cur = [], size = 2;
  for (const r of rows) {
    const s = JSON.stringify(r).length + 1;
    if (cur.length && size + s > MAX_CHUNK_BYTES) { chunks.push(cur); cur = []; size = 2; }
    cur.push(r); size += s;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

// Upsert rows (array of flat objects) into table. Columns come from the first row.
export function upsert(db, table, rows, conflict = ["id"]) {
  rows = rows.filter((r) => conflict.every((c) => r[c] != null));
  if (!rows.length) return [];
  const cols = Object.keys(rows[0]);
  const updates = cols.filter((c) => !conflict.includes(c));
  const sql =
    `INSERT INTO ${table} (${cols.join(", ")}) ` +
    `SELECT ${cols.map((c) => `json_extract(value, '$.${c}')`).join(", ")} FROM json_each(?1) WHERE true ` +
    `ON CONFLICT(${conflict.join(", ")}) DO ` +
    (updates.length ? `UPDATE SET ${updates.map((c) => `${c} = excluded.${c}`).join(", ")}` : "NOTHING");
  return chunkRows(rows).map((chunk) => db.prepare(sql).bind(JSON.stringify(chunk)));
}

// DELETE FROM table WHERE col IN (ids)
export function deleteIn(db, table, col, ids) {
  if (!ids.length) return [];
  return chunkRows(ids).map((chunk) =>
    db.prepare(`DELETE FROM ${table} WHERE ${col} IN (SELECT value FROM json_each(?1))`).bind(JSON.stringify(chunk)),
  );
}

const STATE_COLS = ["resource", "cursor", "window_end", "page_offset", "phase", "run_started",
  "last_success", "last_attempt", "last_error", "next_try", "rows_synced", "extra"];

export async function loadStates(db) {
  const { results } = await db.prepare("SELECT * FROM sync_state").all();
  const out = {};
  for (const r of results) out[r.resource] = { ...r, extra: r.extra ? JSON.parse(r.extra) : {} };
  return out;
}

export function saveState(db, st) {
  const row = { ...st, extra: JSON.stringify(st.extra || {}) };
  return db
    .prepare(`INSERT OR REPLACE INTO sync_state (${STATE_COLS.join(", ")}) VALUES (${STATE_COLS.map(() => "?").join(", ")})`)
    .bind(...STATE_COLS.map((c) => row[c] ?? null));
}
