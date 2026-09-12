# TTC Schedule API

Cloudflare Worker backing `schedule.html`. Per-employee logins (PBKDF2-hashed
passwords, bearer-token sessions in D1), shifts, time-off requests with a
running vacation-day balance, and shift-swap requests — every meaningful
action is written to `activity_log`.

## What's already provisioned

The `ttc_schedule` D1 database has already been created on the Cloudflare
account and its schema applied (see `schema.sql`), with one seed **admin**
account. `wrangler.toml` already points at that live database
(`database_id = feffa7bf-ecd2-4b86-a10a-5760d8014954`), so there's nothing to
create — just deploy the Worker code.

## Deploy

From this folder, with `wrangler` authenticated against the same Cloudflare
account the other `ttc-*` workers live on:

```
wrangler deploy
```

That publishes the Worker as `ttc-schedule-api`, reachable at
`https://ttc-schedule-api.<your-workers-dev-subdomain>.workers.dev` — the
same subdomain the existing `ttc-ops-api` worker uses. `schedule.html`
already points at that URL (`API_BASE` near the top of its `<script>`). If
your account's workers.dev subdomain differs, update `API_BASE` in
`schedule.html` to match after deploying.

## First login

- Username: `admin`
- Password: shared with you separately (not stored in this repo) — you'll be
  forced to set your own password on first login.

Once logged in as admin, use the **Employees** tab to add real accounts for
yourself and each employee. Each new account gets a one-time temporary
password shown on screen — pass it along and they'll set their own on first
login.

## Notes / known limitations (v1)

- A time-off request's day count is a simple inclusive calendar-day count
  between the start and end dates (it doesn't exclude weekends).
- A "swap" reassigns one shift to a coworker (the common "can you cover my
  shift" case) — it isn't a two-way trade of two different shifts.
- Employees can only offer a swap for one of their own shifts that's visible
  in the currently-viewed week on the Schedule tab.
- No email/SMS notifications — everyone needs to check the app for new
  requests, approvals, and swap offers.
