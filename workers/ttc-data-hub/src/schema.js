// Applies schema.sql to D1 whenever its contents change, so a deploy is all
// that's needed — no manual `wrangler d1 execute`.
import SCHEMA from "../schema.sql";

let applied = false;

function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return String(h >>> 0);
}

export async function ensureSchema(db) {
  if (applied) return;
  const version = hash(SCHEMA);
  try {
    const row = await db.prepare("SELECT extra FROM sync_state WHERE resource = '_schema'").first();
    if (row && row.extra === version) { applied = true; return; }
  } catch (_) { /* first run: sync_state doesn't exist yet */ }
  const statements = SCHEMA.replace(/--[^\n]*/g, "").split(";").map((s) => s.trim()).filter(Boolean);
  await db.batch([
    ...statements.map((s) => db.prepare(s)),
    db.prepare("INSERT OR REPLACE INTO sync_state (resource, extra) VALUES ('_schema', ?)").bind(version),
  ]);
  applied = true;
}
