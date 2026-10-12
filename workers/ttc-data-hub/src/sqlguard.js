// Read-only guard for the free-form SQL tool. D1 has no read-only connection
// mode, so we only allow a single SELECT / WITH / VALUES / EXPLAIN statement
// (or PRAGMA table_info / table_list) and reject any write keyword outside
// string literals.

const WRITE_WORDS = /\b(insert|update|delete|drop|alter|create|attach|detach|vacuum|reindex|truncate)\b|\breplace\b(?!\s*\()|\bpragma\b(?!\s+(table_info|table_list|index_list|index_info|foreign_key_list)\b)/i;

export function readOnlySql(input) {
  let sql = String(input || "")
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .trim()
    .replace(/;\s*$/, "");
  if (!sql) throw new Error("Empty SQL");
  const literalsOut = sql.replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""');
  if (literalsOut.includes(";")) throw new Error("Only one statement per call");
  if (!/^(select|with|values|explain|pragma)\b/i.test(literalsOut)) {
    throw new Error("Read-only: statement must start with SELECT, WITH, VALUES, EXPLAIN or PRAGMA table_info");
  }
  if (WRITE_WORDS.test(literalsOut)) throw new Error("Read-only: write statements are not allowed");
  return { sql, wrappable: /^(select|with|values)\b/i.test(literalsOut) };
}
