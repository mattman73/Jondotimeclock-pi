-- ============================================================
-- Jondo Time Clock - Dashboard schema additions
-- Run this once against the existing `timeclock` MySQL database.
-- It only ADDS tables; nothing in the legacy phpTimeclock schema
-- (employees, info, audit, groups, offices, punchlist) is touched.
-- ============================================================

-- Per-employee shift definition. Used by the alert engine and
-- the "expected vs. actual" columns in the reports.
-- Times are stored as local "HH:MM" strings to match how the
-- PHP app displays times. Days-of-week is a 7-char bitmask
-- starting Monday: e.g. "1111100" = Mon-Fri.
CREATE TABLE IF NOT EXISTS schedules (
    empfullname     VARCHAR(50) NOT NULL,
    shift_start     VARCHAR(5)  NOT NULL DEFAULT '09:00',
    shift_end       VARCHAR(5)  NOT NULL DEFAULT '17:00',
    workdays        VARCHAR(7)  NOT NULL DEFAULT '1111100',
    grace_minutes   INT         NOT NULL DEFAULT 10,
    active          TINYINT(1)  NOT NULL DEFAULT 1,
    PRIMARY KEY (empfullname)
);

-- Single-row table holding global alert settings. Using a fixed
-- id = 1 keeps it simple and lets us UPSERT.
CREATE TABLE IF NOT EXISTS alert_settings (
    id                  INT          NOT NULL DEFAULT 1,
    manager_email       VARCHAR(255) NOT NULL DEFAULT '',
    notify_manager      TINYINT(1)   NOT NULL DEFAULT 1,
    notify_employee     TINYINT(1)   NOT NULL DEFAULT 1,
    smtp_host           VARCHAR(255) NOT NULL DEFAULT '',
    smtp_port           INT          NOT NULL DEFAULT 587,
    smtp_user           VARCHAR(255) NOT NULL DEFAULT '',
    smtp_pass           VARCHAR(255) NOT NULL DEFAULT '',
    smtp_from           VARCHAR(255) NOT NULL DEFAULT '',
    smtp_secure         TINYINT(1)   NOT NULL DEFAULT 0,
    company_name        VARCHAR(100) NOT NULL DEFAULT 'Jondo',
    PRIMARY KEY (id)
);

INSERT IGNORE INTO alert_settings (id) VALUES (1);

-- One row per "this employee was late on this date" event.
-- Prevents duplicate alerts and feeds the dashboard's
-- late-arrivals report.
CREATE TABLE IF NOT EXISTS alerts_log (
    id              INT          NOT NULL AUTO_INCREMENT,
    empfullname     VARCHAR(50)  NOT NULL,
    alert_date      DATE         NOT NULL,
    expected_start  VARCHAR(5)   NOT NULL,
    minutes_late    INT          NOT NULL,
    manager_emailed TINYINT(1)   NOT NULL DEFAULT 0,
    employee_emailed TINYINT(1)  NOT NULL DEFAULT 0,
    created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at     DATETIME     NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uniq_emp_date (empfullname, alert_date),
    KEY idx_alert_date (alert_date)
);

-- Index that speeds up "find punches for date X" queries used
-- everywhere in the dashboard. The legacy schema has no index
-- on info.timestamp, so big date-range reports currently scan.
-- This is safe to add.
CREATE INDEX idx_info_timestamp ON info (timestamp);
