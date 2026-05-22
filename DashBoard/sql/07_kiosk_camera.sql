-- Kiosk camera live-view URL.
-- The MJPEG stream served by the Pi scanner (e.g.
-- http://192.168.x.x:8080/stream). When set, the kiosk clock-in
-- page shows a live camera preview so staff can see they're
-- framed correctly for face recognition. Leave blank to hide it.
ALTER TABLE alert_settings ADD COLUMN kiosk_camera_url VARCHAR(255) NOT NULL DEFAULT '';
