-- ============================================================
-- Time-off requests.
--
-- Each row is one request. Hours-based so we can handle full
-- days, half days, and short appointments uniformly. The
-- `hours_requested` column is computed at submit time and frozen
-- on the row so changing the workday-hours setting later doesn't
-- retroactively change someone's used allowance.
-- ============================================================

CREATE TABLE IF NOT EXISTS time_off_requests (
    id              INT          NOT NULL AUTO_INCREMENT,
    empfullname     VARCHAR(50)  NOT NULL,
    request_type    VARCHAR(40)  NOT NULL,   -- holiday | sick | appointment | compassionate | other
    start_datetime  DATETIME     NOT NULL,
    end_datetime    DATETIME     NOT NULL,
    hours_requested DECIMAL(6,2) NOT NULL DEFAULT 0,
    reason          VARCHAR(500) NOT NULL DEFAULT '',
    status          VARCHAR(20)  NOT NULL DEFAULT 'pending',
                                              -- pending | approved | rejected | cancelled
    submitted_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    reviewed_at     DATETIME     NULL,
    reviewed_by     VARCHAR(50)  NULL,
    review_note     VARCHAR(500) NOT NULL DEFAULT '',
    PRIMARY KEY (id),
    KEY idx_emp (empfullname),
    KEY idx_status (status),
    KEY idx_start (start_datetime),
    KEY idx_end (end_datetime)
);

-- Per-employee holiday allowance, stored in hours so the maths
-- works for partial-day requests. Default 224h = 28 standard days.
ALTER TABLE employees ADD COLUMN holiday_allowance_hours DECIMAL(6,2) NOT NULL DEFAULT 224.00;

-- Global settings for the time-off engine.
ALTER TABLE alert_settings ADD COLUMN min_holiday_notice_days INT NOT NULL DEFAULT 14;
ALTER TABLE alert_settings ADD COLUMN standard_workday_hours DECIMAL(4,2) NOT NULL DEFAULT 8.00;
ALTER TABLE alert_settings ADD COLUMN timeoff_notify_email VARCHAR(255) NOT NULL DEFAULT '';
