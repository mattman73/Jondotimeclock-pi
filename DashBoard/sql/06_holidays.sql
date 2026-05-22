-- ============================================================
-- Company-wide non-working days.
--
-- One row per date the office is closed: UK bank holidays,
-- Christmas shutdown, training days, etc. Used by two engines:
--
--  1. services/timeoff.js  - hours falling on these days don't
--     count against an employee's holiday allowance. So a 5-day
--     holiday over Easter doesn't burn 2 of those days for Good
--     Friday + Easter Monday.
--  2. services/alerts.js   - late-arrival alerts are suppressed
--     on these days. No-one's expected in.
--
-- Admins manage these via /holidays.
-- ============================================================

CREATE TABLE IF NOT EXISTS non_working_days (
    holiday_date DATE          NOT NULL,
    label        VARCHAR(80)   NOT NULL DEFAULT '',
    created_at   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by   VARCHAR(50)   NOT NULL DEFAULT '',
    PRIMARY KEY (holiday_date)
);
