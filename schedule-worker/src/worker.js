// TTC Employee Scheduling API
// Backs schedule.html. D1-backed: per-employee logins, shifts, time-off
// requests (with a running vacation-day balance), and shift-swap requests —
// every meaningful action is written to activity_log as an audit trail.

const SESSION_DAYS = 30;
const PBKDF2_ITERATIONS = 100000;

// ---------- small helpers ----------

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    },
  });
}

function corsPreflight() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    },
  });
}

function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomHex(numBytes) {
  const arr = new Uint8Array(numBytes);
  crypto.getRandomValues(arr);
  return bytesToHex(arr);
}

function randomPassword(len = 12) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[arr[i] % alphabet.length];
  return out;
}

async function hashPassword(password, saltHex) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: enc.encode(saltHex), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return bytesToHex(new Uint8Array(bits));
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function daysBetweenInclusive(startStr, endStr) {
  const start = new Date(startStr + "T00:00:00Z");
  const end = new Date(endStr + "T00:00:00Z");
  const diff = Math.round((end - start) / 86400000) + 1;
  return diff > 0 ? diff : 0;
}

function publicEmployee(e) {
  return {
    id: e.id,
    name: e.name,
    username: e.username,
    email: e.email,
    role: e.role,
    vacation_days_allowance: e.vacation_days_allowance,
    active: !!e.active,
    must_change_password: !!e.must_change_password,
  };
}

async function logActivity(env, actor, action, details) {
  await env.DB.prepare(
    "INSERT INTO activity_log (actor_id, actor_name, action, details) VALUES (?, ?, ?, ?)"
  )
    .bind(actor ? actor.id : null, actor ? actor.name : "system", action, details ? JSON.stringify(details) : null)
    .run();
}

async function vacationBalance(env, employeeId, allowance) {
  const row = await env.DB.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN status='approved' THEN days_requested ELSE 0 END),0) AS used,
       COALESCE(SUM(CASE WHEN status='pending' THEN days_requested ELSE 0 END),0) AS pending
     FROM time_off_requests WHERE employee_id = ?`
  )
    .bind(employeeId)
    .first();
  return {
    allowance,
    used: row.used,
    pending: row.pending,
    remaining: allowance - row.used,
  };
}

// ---------- auth ----------

async function getAuthedEmployee(request, env) {
  const authHeader = request.headers.get("Authorization") || "";
  const m = authHeader.match(/^Bearer (.+)$/);
  if (!m) return null;
  const token = m[1];
  const row = await env.DB.prepare(
    `SELECT e.* FROM sessions s JOIN employees e ON e.id = s.employee_id
     WHERE s.token = ? AND s.expires_at > datetime('now')`
  )
    .bind(token)
    .first();
  return row || null;
}

function requireAuth(employee) {
  if (!employee) return json({ error: "Unauthorized" }, 401);
  return null;
}

function requireAdmin(employee) {
  if (!employee) return json({ error: "Unauthorized" }, 401);
  if (employee.role !== "admin") return json({ error: "Admin access required" }, 403);
  return null;
}

// ---------- route handlers ----------

async function handleLogin(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const { username, password } = body || {};
  if (!username || !password) return json({ error: "username and password required" }, 400);

  const emp = await env.DB.prepare("SELECT * FROM employees WHERE username = ? AND active = 1")
    .bind(username)
    .first();
  if (!emp) return json({ error: "Invalid username or password" }, 401);

  const computed = await hashPassword(password, emp.password_salt);
  if (!timingSafeEqual(computed, emp.password_hash)) {
    return json({ error: "Invalid username or password" }, 401);
  }

  const token = randomHex(32);
  await env.DB.prepare(
    `INSERT INTO sessions (token, employee_id, expires_at) VALUES (?, ?, datetime('now', '+${SESSION_DAYS} days'))`
  )
    .bind(token, emp.id)
    .run();

  await logActivity(env, emp, "login", null);

  return json({ token, employee: publicEmployee(emp) });
}

async function handleLogout(request, env, employee) {
  const authHeader = request.headers.get("Authorization") || "";
  const m = authHeader.match(/^Bearer (.+)$/);
  if (m) await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(m[1]).run();
  await logActivity(env, employee, "logout", null);
  return json({ success: true });
}

async function handleMe(env, employee) {
  const balance = await vacationBalance(env, employee.id, employee.vacation_days_allowance);
  return json({ employee: publicEmployee(employee), vacation: balance });
}

async function handleChangePassword(request, env, employee) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const { current_password, new_password } = body || {};
  if (!current_password || !new_password) return json({ error: "current_password and new_password required" }, 400);
  if (new_password.length < 8) return json({ error: "New password must be at least 8 characters" }, 400);

  const computed = await hashPassword(current_password, employee.password_salt);
  if (!timingSafeEqual(computed, employee.password_hash)) {
    return json({ error: "Current password is incorrect" }, 401);
  }

  const salt = randomHex(16);
  const hash = await hashPassword(new_password, salt);
  await env.DB.prepare(
    "UPDATE employees SET password_hash = ?, password_salt = ?, must_change_password = 0, updated_at = datetime('now') WHERE id = ?"
  )
    .bind(hash, salt, employee.id)
    .run();

  await logActivity(env, employee, "password_changed", null);
  return json({ success: true });
}

// -- employees (admin) --

async function handleListEmployees(env) {
  const { results } = await env.DB.prepare("SELECT * FROM employees ORDER BY name").all();
  return json({ employees: results.map(publicEmployee) });
}

// Any logged-in employee can see coworker names (needed to pick who a shift
// swap goes to) — but not their usernames, roles, or vacation data.
async function handleListCoworkers(env, employee) {
  const { results } = await env.DB.prepare(
    "SELECT id, name FROM employees WHERE active = 1 AND id != ? ORDER BY name"
  )
    .bind(employee.id)
    .all();
  return json({ coworkers: results });
}

async function handleCreateEmployee(request, env, actor) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const { name, username, email, role, vacation_days_allowance } = body || {};
  if (!name || !username) return json({ error: "name and username required" }, 400);
  const finalRole = role === "admin" ? "admin" : "employee";
  const allowance = Number(vacation_days_allowance) || 0;

  const existing = await env.DB.prepare("SELECT id FROM employees WHERE username = ?").bind(username).first();
  if (existing) return json({ error: "That username is already taken" }, 409);

  const tempPassword = randomPassword(12);
  const salt = randomHex(16);
  const hash = await hashPassword(tempPassword, salt);

  const result = await env.DB.prepare(
    `INSERT INTO employees (name, username, email, password_hash, password_salt, role, vacation_days_allowance, must_change_password)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
  )
    .bind(name, username, email || null, hash, salt, finalRole, allowance)
    .run();

  await logActivity(env, actor, "employee_created", { employee: name, username, role: finalRole });

  const emp = await env.DB.prepare("SELECT * FROM employees WHERE id = ?").bind(result.meta.last_row_id).first();
  return json({ employee: publicEmployee(emp), temporary_password: tempPassword }, 201);
}

async function handleUpdateEmployee(request, env, actor, id) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const emp = await env.DB.prepare("SELECT * FROM employees WHERE id = ?").bind(id).first();
  if (!emp) return json({ error: "Not found" }, 404);

  const name = body.name ?? emp.name;
  const email = body.email ?? emp.email;
  const role = body.role === "admin" || body.role === "employee" ? body.role : emp.role;
  const allowance = body.vacation_days_allowance != null ? Number(body.vacation_days_allowance) : emp.vacation_days_allowance;
  const active = body.active != null ? (body.active ? 1 : 0) : emp.active;

  await env.DB.prepare(
    "UPDATE employees SET name=?, email=?, role=?, vacation_days_allowance=?, active=?, updated_at=datetime('now') WHERE id=?"
  )
    .bind(name, email, role, allowance, active, id)
    .run();

  await logActivity(env, actor, "employee_updated", { employee: name, changes: body });
  const updated = await env.DB.prepare("SELECT * FROM employees WHERE id = ?").bind(id).first();
  return json({ employee: publicEmployee(updated) });
}

async function handleResetPassword(env, actor, id) {
  const emp = await env.DB.prepare("SELECT * FROM employees WHERE id = ?").bind(id).first();
  if (!emp) return json({ error: "Not found" }, 404);

  const tempPassword = randomPassword(12);
  const salt = randomHex(16);
  const hash = await hashPassword(tempPassword, salt);
  await env.DB.prepare(
    "UPDATE employees SET password_hash=?, password_salt=?, must_change_password=1, updated_at=datetime('now') WHERE id=?"
  )
    .bind(hash, salt, id)
    .run();
  await env.DB.prepare("DELETE FROM sessions WHERE employee_id = ?").bind(id).run();

  await logActivity(env, actor, "password_reset", { employee: emp.name });
  return json({ temporary_password: tempPassword });
}

// -- shifts --

async function handleListShifts(request, env, employee) {
  const url = new URL(request.url);
  const start = url.searchParams.get("start");
  const end = url.searchParams.get("end");
  if (!start || !end) return json({ error: "start and end query params (YYYY-MM-DD) required" }, 400);

  // Every employee can see the whole team's schedule (read-only) — only
  // admins can create, edit, or delete shifts (enforced in the router).
  const { results } = await env.DB.prepare(
    `SELECT s.*, e.name AS employee_name FROM shifts s JOIN employees e ON e.id = s.employee_id
     WHERE s.shift_date BETWEEN ? AND ? ORDER BY s.shift_date, s.start_time`
  )
    .bind(start, end)
    .all();
  return json({ shifts: results });
}

async function handleCreateShift(request, env, actor) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const { employee_id, shift_date, start_time, end_time, notes } = body || {};
  if (!employee_id || !shift_date || !start_time || !end_time) {
    return json({ error: "employee_id, shift_date, start_time, end_time required" }, 400);
  }
  const result = await env.DB.prepare(
    "INSERT INTO shifts (employee_id, shift_date, start_time, end_time, notes, created_by) VALUES (?, ?, ?, ?, ?, ?)"
  )
    .bind(employee_id, shift_date, start_time, end_time, notes || null, actor.id)
    .run();

  await logActivity(env, actor, "shift_created", { employee_id, shift_date, start_time, end_time });
  const shift = await env.DB.prepare("SELECT * FROM shifts WHERE id = ?").bind(result.meta.last_row_id).first();
  return json({ shift }, 201);
}

async function handleUpdateShift(request, env, actor, id) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const shift = await env.DB.prepare("SELECT * FROM shifts WHERE id = ?").bind(id).first();
  if (!shift) return json({ error: "Not found" }, 404);

  const employee_id = body.employee_id ?? shift.employee_id;
  const shift_date = body.shift_date ?? shift.shift_date;
  const start_time = body.start_time ?? shift.start_time;
  const end_time = body.end_time ?? shift.end_time;
  const notes = body.notes !== undefined ? body.notes : shift.notes;

  await env.DB.prepare(
    "UPDATE shifts SET employee_id=?, shift_date=?, start_time=?, end_time=?, notes=?, updated_at=datetime('now') WHERE id=?"
  )
    .bind(employee_id, shift_date, start_time, end_time, notes, id)
    .run();

  await logActivity(env, actor, "shift_updated", { shift_id: id, changes: body });
  const updated = await env.DB.prepare("SELECT * FROM shifts WHERE id = ?").bind(id).first();
  return json({ shift: updated });
}

async function handleDeleteShift(env, actor, id) {
  const shift = await env.DB.prepare("SELECT * FROM shifts WHERE id = ?").bind(id).first();
  if (!shift) return json({ error: "Not found" }, 404);
  await env.DB.prepare("DELETE FROM shifts WHERE id = ?").bind(id).run();
  await logActivity(env, actor, "shift_deleted", { shift_id: id, shift_date: shift.shift_date, employee_id: shift.employee_id });
  return json({ deleted: id });
}

// -- time off --

async function handleListTimeOff(request, env, employee) {
  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  let sql = `SELECT t.*, e.name AS employee_name FROM time_off_requests t JOIN employees e ON e.id = t.employee_id WHERE 1=1`;
  const params = [];
  if (employee.role !== "admin") {
    sql += " AND t.employee_id = ?";
    params.push(employee.id);
  }
  if (status) {
    sql += " AND t.status = ?";
    params.push(status);
  }
  sql += " ORDER BY t.requested_at DESC";
  const { results } = await env.DB.prepare(sql).bind(...params).all();
  return json({ requests: results });
}

async function handleCreateTimeOff(request, env, actor) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const { start_date, end_date, reason } = body || {};
  if (!start_date || !end_date) return json({ error: "start_date and end_date required" }, 400);
  const days = daysBetweenInclusive(start_date, end_date);
  if (days <= 0) return json({ error: "end_date must be on or after start_date" }, 400);

  const result = await env.DB.prepare(
    "INSERT INTO time_off_requests (employee_id, start_date, end_date, days_requested, reason) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(actor.id, start_date, end_date, days, reason || null)
    .run();

  await logActivity(env, actor, "time_off_requested", { start_date, end_date, days });
  const reqRow = await env.DB.prepare("SELECT * FROM time_off_requests WHERE id = ?").bind(result.meta.last_row_id).first();
  const balance = await vacationBalance(env, actor.id, actor.vacation_days_allowance);
  return json({ request: reqRow, vacation: balance }, 201);
}

async function handleDecideTimeOff(request, env, actor, id) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const { decision } = body || {};
  if (decision !== "approved" && decision !== "denied") return json({ error: "decision must be 'approved' or 'denied'" }, 400);

  const reqRow = await env.DB.prepare("SELECT * FROM time_off_requests WHERE id = ?").bind(id).first();
  if (!reqRow) return json({ error: "Not found" }, 404);
  if (reqRow.status !== "pending") return json({ error: `Request is already ${reqRow.status}` }, 409);

  await env.DB.prepare(
    "UPDATE time_off_requests SET status=?, decided_by=?, decided_at=datetime('now') WHERE id=?"
  )
    .bind(decision, actor.id, id)
    .run();

  await logActivity(env, actor, "time_off_" + decision, { request_id: id, employee_id: reqRow.employee_id, days: reqRow.days_requested });
  const updated = await env.DB.prepare("SELECT * FROM time_off_requests WHERE id = ?").bind(id).first();
  return json({ request: updated });
}

async function handleCancelTimeOff(env, actor, id) {
  const reqRow = await env.DB.prepare("SELECT * FROM time_off_requests WHERE id = ?").bind(id).first();
  if (!reqRow) return json({ error: "Not found" }, 404);
  if (reqRow.employee_id !== actor.id && actor.role !== "admin") return json({ error: "Not your request" }, 403);
  if (reqRow.status !== "pending") return json({ error: `Request is already ${reqRow.status}` }, 409);

  await env.DB.prepare("UPDATE time_off_requests SET status='cancelled' WHERE id=?").bind(id).run();
  await logActivity(env, actor, "time_off_cancelled", { request_id: id });
  return json({ cancelled: id });
}

// -- shift swaps --

async function handleListSwaps(env, employee) {
  let sql = `SELECT sw.*, s.shift_date, s.start_time, s.end_time,
                    f.name AS from_name, t.name AS to_name
             FROM swap_requests sw
             JOIN shifts s ON s.id = sw.shift_id
             JOIN employees f ON f.id = sw.from_employee_id
             JOIN employees t ON t.id = sw.to_employee_id`;
  const params = [];
  if (employee.role !== "admin") {
    sql += " WHERE sw.from_employee_id = ? OR sw.to_employee_id = ?";
    params.push(employee.id, employee.id);
  }
  sql += " ORDER BY sw.requested_at DESC";
  const { results } = await env.DB.prepare(sql).bind(...params).all();
  return json({ swaps: results });
}

async function handleCreateSwap(request, env, actor) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const { shift_id, to_employee_id } = body || {};
  if (!shift_id || !to_employee_id) return json({ error: "shift_id and to_employee_id required" }, 400);

  const shift = await env.DB.prepare("SELECT * FROM shifts WHERE id = ?").bind(shift_id).first();
  if (!shift) return json({ error: "Shift not found" }, 404);
  if (shift.employee_id !== actor.id && actor.role !== "admin") {
    return json({ error: "You can only offer your own shifts" }, 403);
  }
  if (Number(to_employee_id) === shift.employee_id) {
    return json({ error: "Pick a different coworker to take the shift" }, 400);
  }
  const target = await env.DB.prepare("SELECT * FROM employees WHERE id = ? AND active = 1").bind(to_employee_id).first();
  if (!target) return json({ error: "Target employee not found" }, 404);

  const result = await env.DB.prepare(
    "INSERT INTO swap_requests (shift_id, from_employee_id, to_employee_id) VALUES (?, ?, ?)"
  )
    .bind(shift_id, shift.employee_id, to_employee_id)
    .run();

  await logActivity(env, actor, "swap_requested", { shift_id, from_employee_id: shift.employee_id, to_employee_id });
  const swap = await env.DB.prepare("SELECT * FROM swap_requests WHERE id = ?").bind(result.meta.last_row_id).first();
  return json({ swap }, 201);
}

async function handleRespondSwap(request, env, actor, id) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const { decision } = body || {};
  if (decision !== "accepted" && decision !== "declined") return json({ error: "decision must be 'accepted' or 'declined'" }, 400);

  const swap = await env.DB.prepare("SELECT * FROM swap_requests WHERE id = ?").bind(id).first();
  if (!swap) return json({ error: "Not found" }, 404);
  if (swap.to_employee_id !== actor.id) return json({ error: "Only the requested coworker can respond" }, 403);
  if (swap.status !== "pending") return json({ error: `Swap is already ${swap.status}` }, 409);

  await env.DB.prepare(
    "UPDATE swap_requests SET status=?, responded_at=datetime('now') WHERE id=?"
  )
    .bind(decision, id)
    .run();

  await logActivity(env, actor, "swap_" + decision, { swap_id: id });
  const updated = await env.DB.prepare("SELECT * FROM swap_requests WHERE id = ?").bind(id).first();
  return json({ swap: updated });
}

async function handleDecideSwap(request, env, actor, id) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const { decision } = body || {};
  if (decision !== "approved" && decision !== "denied") return json({ error: "decision must be 'approved' or 'denied'" }, 400);

  const swap = await env.DB.prepare("SELECT * FROM swap_requests WHERE id = ?").bind(id).first();
  if (!swap) return json({ error: "Not found" }, 404);
  if (decision === "approved" && swap.status !== "accepted") {
    return json({ error: "The coworker must accept the swap before it can be approved" }, 409);
  }
  if (swap.status !== "accepted" && swap.status !== "pending") {
    return json({ error: `Swap is already ${swap.status}` }, 409);
  }

  await env.DB.prepare("UPDATE swap_requests SET status=?, decided_by=?, decided_at=datetime('now') WHERE id=?")
    .bind(decision, actor.id, id)
    .run();

  if (decision === "approved") {
    await env.DB.prepare("UPDATE shifts SET employee_id=?, updated_at=datetime('now') WHERE id=?")
      .bind(swap.to_employee_id, swap.shift_id)
      .run();
  }

  await logActivity(env, actor, "swap_" + decision, {
    swap_id: id,
    shift_id: swap.shift_id,
    from_employee_id: swap.from_employee_id,
    to_employee_id: swap.to_employee_id,
  });
  const updated = await env.DB.prepare("SELECT * FROM swap_requests WHERE id = ?").bind(id).first();
  return json({ swap: updated });
}

async function handleCancelSwap(env, actor, id) {
  const swap = await env.DB.prepare("SELECT * FROM swap_requests WHERE id = ?").bind(id).first();
  if (!swap) return json({ error: "Not found" }, 404);
  if (swap.from_employee_id !== actor.id && actor.role !== "admin") return json({ error: "Not your request" }, 403);
  if (swap.status !== "pending" && swap.status !== "accepted") return json({ error: `Swap is already ${swap.status}` }, 409);

  await env.DB.prepare("UPDATE swap_requests SET status='cancelled' WHERE id=?").bind(id).run();
  await logActivity(env, actor, "swap_cancelled", { swap_id: id });
  return json({ cancelled: id });
}

// -- activity log (admin) --

async function handleListLog(request, env) {
  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get("limit")) || 100, 500);
  const { results } = await env.DB.prepare(
    "SELECT * FROM activity_log ORDER BY created_at DESC, id DESC LIMIT ?"
  )
    .bind(limit)
    .all();
  return json({ log: results });
}

// ---------- router ----------

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return corsPreflight();

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      if (path === "/api/login" && method === "POST") return handleLogin(request, env);

      // Everything below requires a valid session.
      const employee = await getAuthedEmployee(request, env);

      if (path === "/api/logout" && method === "POST") {
        const err = requireAuth(employee);
        if (err) return err;
        return handleLogout(request, env, employee);
      }
      if (path === "/api/me" && method === "GET") {
        const err = requireAuth(employee);
        if (err) return err;
        return handleMe(env, employee);
      }
      if (path === "/api/change-password" && method === "POST") {
        const err = requireAuth(employee);
        if (err) return err;
        return handleChangePassword(request, env, employee);
      }

      if (path === "/api/coworkers" && method === "GET") {
        const err = requireAuth(employee);
        if (err) return err;
        return handleListCoworkers(env, employee);
      }
      if (path === "/api/employees" && method === "GET") {
        const err = requireAdmin(employee);
        if (err) return err;
        return handleListEmployees(env);
      }
      if (path === "/api/employees" && method === "POST") {
        const err = requireAdmin(employee);
        if (err) return err;
        return handleCreateEmployee(request, env, employee);
      }
      let m = path.match(/^\/api\/employees\/(\d+)$/);
      if (m && method === "PATCH") {
        const err = requireAdmin(employee);
        if (err) return err;
        return handleUpdateEmployee(request, env, employee, Number(m[1]));
      }
      m = path.match(/^\/api\/employees\/(\d+)\/reset-password$/);
      if (m && method === "POST") {
        const err = requireAdmin(employee);
        if (err) return err;
        return handleResetPassword(env, employee, Number(m[1]));
      }

      if (path === "/api/shifts" && method === "GET") {
        const err = requireAuth(employee);
        if (err) return err;
        return handleListShifts(request, env, employee);
      }
      if (path === "/api/shifts" && method === "POST") {
        const err = requireAdmin(employee);
        if (err) return err;
        return handleCreateShift(request, env, employee);
      }
      m = path.match(/^\/api\/shifts\/(\d+)$/);
      if (m && method === "PATCH") {
        const err = requireAdmin(employee);
        if (err) return err;
        return handleUpdateShift(request, env, employee, Number(m[1]));
      }
      if (m && method === "DELETE") {
        const err = requireAdmin(employee);
        if (err) return err;
        return handleDeleteShift(env, employee, Number(m[1]));
      }

      if (path === "/api/timeoff" && method === "GET") {
        const err = requireAuth(employee);
        if (err) return err;
        return handleListTimeOff(request, env, employee);
      }
      if (path === "/api/timeoff" && method === "POST") {
        const err = requireAuth(employee);
        if (err) return err;
        return handleCreateTimeOff(request, env, employee);
      }
      m = path.match(/^\/api\/timeoff\/(\d+)\/decide$/);
      if (m && method === "POST") {
        const err = requireAdmin(employee);
        if (err) return err;
        return handleDecideTimeOff(request, env, employee, Number(m[1]));
      }
      m = path.match(/^\/api\/timeoff\/(\d+)\/cancel$/);
      if (m && method === "POST") {
        const err = requireAuth(employee);
        if (err) return err;
        return handleCancelTimeOff(env, employee, Number(m[1]));
      }

      if (path === "/api/swaps" && method === "GET") {
        const err = requireAuth(employee);
        if (err) return err;
        return handleListSwaps(env, employee);
      }
      if (path === "/api/swaps" && method === "POST") {
        const err = requireAuth(employee);
        if (err) return err;
        return handleCreateSwap(request, env, employee);
      }
      m = path.match(/^\/api\/swaps\/(\d+)\/respond$/);
      if (m && method === "POST") {
        const err = requireAuth(employee);
        if (err) return err;
        return handleRespondSwap(request, env, employee, Number(m[1]));
      }
      m = path.match(/^\/api\/swaps\/(\d+)\/decide$/);
      if (m && method === "POST") {
        const err = requireAdmin(employee);
        if (err) return err;
        return handleDecideSwap(request, env, employee, Number(m[1]));
      }
      m = path.match(/^\/api\/swaps\/(\d+)\/cancel$/);
      if (m && method === "POST") {
        const err = requireAuth(employee);
        if (err) return err;
        return handleCancelSwap(env, employee, Number(m[1]));
      }

      if (path === "/api/log" && method === "GET") {
        const err = requireAdmin(employee);
        if (err) return err;
        return handleListLog(request, env);
      }

      return json({ error: "Not found" }, 404);
    } catch (e) {
      return json({ error: "Server error", detail: String(e && e.message ? e.message : e) }, 500);
    }
  },
};
