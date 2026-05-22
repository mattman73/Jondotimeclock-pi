# Jondo Time Clock — Admin Dashboard

A Node.js admin dashboard that sits next to the existing PHP time-clock app. Staff still clock in via the original web pages; managers use this dashboard to add/edit staff, define shifts, run reports and receive late-arrival alerts.

## What it adds

- **Dashboard home** — live "who's in / out / late" board for today.
- **Staff management** — full CRUD on the `employees` table. New users can sign in to both the dashboard *and* the PHP clock-in app (passwords use the same `crypt('xy')` format).
- **Schedules** — per-employee shift start/end, working days and grace minutes.
- **Reports** — daily attendance, weekly/monthly hours, late arrivals & missed clock-ins. Excel and CSV export.
- **Alert engine** — cron job (default: every minute) that flags employees who haven't clocked in by `shift_start + grace`, emails the manager and/or the employee, and surfaces an alert on the dashboard.
- **Settings** — configure manager email, SMTP credentials, and toggle each notification channel from the UI.

It uses the same MySQL database as the PHP app, so nothing is duplicated.

## Prerequisites

- Node.js 18 or later
- The existing `timeclock` MySQL database (created by the PHP install)
- SMTP relay or account (Office 365, Google, internal Exchange — whatever your manager email lives on)

## Install

```bash
cd dashboard
npm install
cp .env.example .env
# edit .env: set DB_PASS, SESSION_SECRET, TZ
npm run migrate     # adds schedules, alert_settings, alerts_log tables
npm start
```

Visit http://localhost:3000 and sign in with any existing **admin** or **time_admin** account from the PHP app (e.g. `admin` / its current password). Then:

1. Open **Settings** → enter the manager email and SMTP details, **Save**, then **Send test email** to confirm.
2. Open **Schedules** → set shift start/end and working days for each employee. Tick **Active** for any employee who should trigger late-arrival alerts.
3. Done. The cron job runs once a minute by default.

## Configuration

All runtime config lives in `.env`. The most important keys:

| key | what it does |
|---|---|
| `PORT` | HTTP port for the dashboard (default 3000) |
| `SESSION_SECRET` | random string used to sign session cookies — set this to something long |
| `DB_HOST` / `DB_USER` / `DB_PASS` / `DB_NAME` | should match `config.inc.php` |
| `DB_PREFIX` | leave blank unless you use a phpTimeclock table prefix |
| `ALERT_CRON` | cron expression for the late-arrival check (default `* * * * *` = every minute) |
| `TZ` | IANA timezone for shift maths, e.g. `Europe/London` |

SMTP host/port/credentials are stored *in the database* via the Settings page (so you can change them without redeploying).

## Running on the same server as IIS

You have a few options. The simplest is to run Node on a separate port (3000) alongside IIS, and either:

**A. Reverse proxy with URL Rewrite + ARR.** In IIS, install URL Rewrite + Application Request Routing, then in `web.config` add a rule mapping `/dashboard/*` and `/staff/*` etc. to `http://localhost:3000/...`.

**B. Use `iisnode`.** Install [iisnode](https://github.com/Azure/iisnode/releases) and add a `web.config` to the `dashboard/` folder that points at `server.js`.

**C. Just expose port 3000 internally.** Easiest for a local-network-only setup — open the firewall on 3000 to your LAN and tell managers to bookmark `http://your-server:3000`.

To keep Node running across reboots, install [nssm](https://nssm.cc) and register `node server.js` as a Windows service:

```
nssm install JondoDashboard "C:\Program Files\nodejs\node.exe" "C:\path\to\Jondo time clock\dashboard\server.js"
nssm set JondoDashboard AppDirectory "C:\path\to\Jondo time clock\dashboard"
nssm start JondoDashboard
```

## How alerts work

Every minute the engine looks at every employee with `schedules.active = 1`. For each one whose schedule says "today is a workday", it computes `minutes_past = now - shift_start`. If `minutes_past > grace_minutes` AND no `inout = 'in'` punch exists for that employee today AND no `alerts_log` row exists for `(empfullname, today)`, it:

1. Inserts an `alerts_log` row (the `UNIQUE KEY (empfullname, alert_date)` makes this idempotent — re-running the cron never double-sends).
2. Emails the manager (if `notify_manager` is on and a manager email is configured).
3. Emails the employee (if `notify_employee` is on and the employee has an email address on file).
4. Updates the row with which emails actually sent.

The dashboard's "Mark resolved" button writes `resolved_at` so the row stops showing as a current alert.

## Database changes

Only three new tables are added (see `sql/01_dashboard_tables.sql`):

- `schedules` — shift definitions, one row per employee.
- `alert_settings` — single-row table holding manager email, SMTP creds, toggles.
- `alerts_log` — one row per (employee, date) late event.

Plus an index on `info.timestamp` to keep date-range reports fast.

The legacy phpTimeclock tables (`employees`, `info`, `audit`, `groups`, `offices`, `punchlist`) are **not** modified, so the existing PHP app continues to work unchanged.

## Project layout

```
dashboard/
├── server.js              # Express boot
├── db.js                  # mysql2 pool
├── package.json
├── .env.example
├── routes/
│   ├── auth.js            # login/logout
│   ├── dashboard.js       # /dashboard
│   ├── staff.js           # /staff CRUD
│   ├── schedules.js       # /schedules
│   ├── reports.js         # /reports + xlsx/csv export
│   └── settings.js        # /settings
├── services/
│   ├── auth.js            # crypt('xy')-compatible password helpers
│   ├── timeUtils.js       # epoch <-> local-day conversions
│   ├── reports.js         # report builders (used by HTML + exports)
│   ├── mailer.js          # nodemailer wrapper, SMTP from DB
│   └── alerts.js          # cron-driven late-arrival engine
├── views/                 # EJS templates
├── public/css/style.css
├── scripts/migrate.js     # `npm run migrate`
└── sql/01_dashboard_tables.sql
```

## Troubleshooting

**Login fails for the original `admin` account.** The PHP app stores passwords with `crypt($pwd, 'xy')` using DES — that's a 13-character hash. We use `unix-crypt-td-js` to verify the same hash. If sign-in still fails, reset the password from the PHP admin panel; the dashboard will then accept the new password too.

**Alerts aren't firing.** In Settings, click **Run alert check now**. The flash message tells you how many employees were checked and how many alerts fired. If "checked: 0", you have no employees with `schedules.active = 1` *and* today in their workday mask. If alerts fire but emails don't arrive, click **Send test email** — that surfaces the SMTP error.

**Times look wrong.** Make sure `TZ` in `.env` matches the timezone your servers report wall-clock in (the PHP app stores Unix epoch, so timezone conversion happens at display time).
