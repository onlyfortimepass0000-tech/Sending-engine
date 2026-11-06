-- Local development client. Public key: pk_dev_local. Accepts posts from any origin.
-- Safe to run repeatedly. Never use this key or "*" origins in production.
INSERT OR IGNORE INTO clients (id, name, slug, public_key, allowed_origins, timezone, active, created_at)
VALUES ('client_dev', 'Dev Client', 'dev', 'pk_dev_local', '["*"]', 'Asia/Kolkata', 1, '2026-01-01T00:00:00.000Z');

INSERT OR IGNORE INTO client_settings (client_id, settings, updated_at)
VALUES ('client_dev', '{"categories":[{"name":"Emergency","keywords":["broken tooth","pain","swelling"]},{"name":"Whitening","keywords":["whitening","bleach"]}],"alert_recipients":["owner@dev.example"],"reply_to":"owner@dev.example","business_address":"1 Dev Road, Thane"}', '2026-01-01T00:00:00.000Z');
