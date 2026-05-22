-- Camera operating schedule for the face-recognition kiosk.
-- The camera is mainly used at the start and end of the day, so the
-- Pi pauses face recognition outside two configurable daily windows
-- (a morning window and an evening window).
-- A staff member can tap the "sleeping" image on the kiosk to wake
-- the camera for camera_wake_minutes minutes; camera_wake_until
-- holds the epoch-seconds deadline of that manual override.
ALTER TABLE alert_settings ADD COLUMN camera_schedule_enabled TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE alert_settings ADD COLUMN camera_morning_on VARCHAR(5) NOT NULL DEFAULT '07:00';
ALTER TABLE alert_settings ADD COLUMN camera_morning_off VARCHAR(5) NOT NULL DEFAULT '10:00';
ALTER TABLE alert_settings ADD COLUMN camera_evening_on VARCHAR(5) NOT NULL DEFAULT '16:00';
ALTER TABLE alert_settings ADD COLUMN camera_evening_off VARCHAR(5) NOT NULL DEFAULT '19:00';
ALTER TABLE alert_settings ADD COLUMN camera_wake_minutes INT NOT NULL DEFAULT 15;
ALTER TABLE alert_settings ADD COLUMN camera_wake_until BIGINT NULL DEFAULT NULL;
