-- WhatsApp notifications via the Meta WhatsApp Business Cloud API.
-- These run ALONGSIDE the existing email alerts (they don't replace
-- them) to nudge managers about late staff and new time-off
-- requests.
--
-- The Cloud API cannot post into a WhatsApp group, so
-- whatsapp_recipients is a comma-separated list of individual
-- manager phone numbers in international format (digits only,
-- e.g. 447911123456).
--
-- whatsapp_template is the name of a pre-approved message template
-- (created in Meta Business Manager) that has a single body
-- variable {{1}} — the dashboard passes the alert text as it.
ALTER TABLE alert_settings ADD COLUMN whatsapp_enabled TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE alert_settings ADD COLUMN whatsapp_phone_id VARCHAR(40) NOT NULL DEFAULT '';
ALTER TABLE alert_settings ADD COLUMN whatsapp_token VARCHAR(600) NOT NULL DEFAULT '';
ALTER TABLE alert_settings ADD COLUMN whatsapp_recipients VARCHAR(500) NOT NULL DEFAULT '';
ALTER TABLE alert_settings ADD COLUMN whatsapp_template VARCHAR(100) NOT NULL DEFAULT '';
ALTER TABLE alert_settings ADD COLUMN whatsapp_lang VARCHAR(12) NOT NULL DEFAULT 'en_GB';
