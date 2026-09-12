-- ttc_schedule D1 schema
-- Already applied directly to the live D1 database (ttc_schedule) when this was built.
-- Kept here so the schema is reproducible / reviewable in source control.

CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE,
  email TEXT,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','employee')) DEFAULT 'employee',
  vacation_days_allowance REAL NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 1,
  calendar_token TEXT, -- long random secret; the URL-based auth for that employee's .ics feed
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  shift_date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  notes TEXT,
  created_by INTEGER NOT NULL REFERENCES employees(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS time_off_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  days_requested REAL NOT NULL,
  reason TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending','approved','denied','cancelled')) DEFAULT 'pending',
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_by INTEGER REFERENCES employees(id),
  decided_at TEXT
);

CREATE TABLE IF NOT EXISTS swap_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shift_id INTEGER NOT NULL REFERENCES shifts(id),
  from_employee_id INTEGER NOT NULL REFERENCES employees(id),
  to_employee_id INTEGER NOT NULL REFERENCES employees(id),
  status TEXT NOT NULL CHECK(status IN ('pending','accepted','declined','approved','denied','cancelled')) DEFAULT 'pending',
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  responded_at TEXT,
  decided_by INTEGER REFERENCES employees(id),
  decided_at TEXT
);

-- A recurring weekly pattern per employee (e.g. "Gray works Tue-Sat, 9am-5pm").
-- day_of_week: 0=Monday .. 6=Sunday, matching the app's Monday-start week view.
-- Applying a template for a given week creates real rows in `shifts` — from
-- then on those shifts are independent and editable/deletable like any
-- other, without touching the template.
CREATE TABLE IF NOT EXISTS schedule_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  day_of_week INTEGER NOT NULL CHECK(day_of_week BETWEEN 0 AND 6),
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER NOT NULL REFERENCES employees(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER REFERENCES employees(id),
  actor_name TEXT,
  action TEXT NOT NULL,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
