-- Kiosk behaviour settings.
-- How many seconds the "Clocked IN / OUT" result page stays on
-- screen before auto-redirecting back to the badge scanner.
-- Default 5s; admins can tune via /settings.
ALTER TABLE alert_settings ADD COLUMN kiosk_result_seconds INT NOT NULL DEFAULT 5;
