-- Payments module + sending safety. Append-only from here on (0001 is deployed).

-- ---------------------------------------------------------------- payments
CREATE TABLE payment_imports (
  id          TEXT PRIMARY KEY,
  client_id   TEXT NOT NULL REFERENCES clients(id),
  user_id     TEXT,
  rows_total  INTEGER NOT NULL,
  imported    INTEGER NOT NULL,
  skipped     INTEGER NOT NULL,
  warnings    INTEGER NOT NULL DEFAULT 0,
  report      TEXT NOT NULL,                -- JSON: one line per row with its outcome and reason
  attested_at TEXT NOT NULL,                -- the client confirmed these are real customers who owe money
  created_at  TEXT NOT NULL
);

CREATE TABLE payment_entries (
  id               TEXT PRIMARY KEY,
  client_id        TEXT NOT NULL REFERENCES clients(id),
  import_id        TEXT REFERENCES payment_imports(id),
  customer_name    TEXT NOT NULL,
  email            TEXT NOT NULL,
  phone            TEXT,
  note             TEXT,
  currency         TEXT NOT NULL DEFAULT 'INR',
  amount_minor     INTEGER NOT NULL CHECK (amount_minor > 0),   -- paise / cents
  paid_minor       INTEGER NOT NULL DEFAULT 0 CHECK (paid_minor >= 0),
  due_date         TEXT NOT NULL,                               -- YYYY-MM-DD, the client's local date
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'needs_attention', 'paid')),
  attention_reason TEXT CHECK (attention_reason IN ('sequence_complete', 'send_failed', 'asked_to_stop', 'replied')),
  stages_sent      INTEGER NOT NULL DEFAULT 0 CHECK (stages_sent BETWEEN 0 AND 4),
  last_sent_on     TEXT,
  last_error       TEXT,
  paid_at          TEXT,
  paused_at        TEXT,
  replied_at       TEXT,
  reply_note       TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX idx_pay_entries_client ON payment_entries (client_id, status, due_date);
CREATE INDEX idx_pay_entries_due    ON payment_entries (status, due_date);

-- One row per reminder attempt (the claim). A partial unique index allows only one live send per entry and stage.
CREATE TABLE payment_sends (
  id         TEXT PRIMARY KEY,
  client_id  TEXT NOT NULL REFERENCES clients(id),
  entry_id   TEXT NOT NULL REFERENCES payment_entries(id),
  stage      INTEGER NOT NULL CHECK (stage BETWEEN 1 AND 4),
  recipient  TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('sending', 'sent', 'failed', 'bounced')),
  resend_id  TEXT,
  error      TEXT,
  run_date   TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_pay_sends_live ON payment_sends (entry_id, stage) WHERE status IN ('sending', 'sent');
CREATE INDEX idx_pay_sends_entry ON payment_sends (entry_id, created_at);

CREATE TABLE payment_events (
  id         TEXT PRIMARY KEY,
  client_id  TEXT NOT NULL REFERENCES clients(id),
  entry_id   TEXT NOT NULL REFERENCES payment_entries(id),
  kind       TEXT NOT NULL,
  detail     TEXT,
  actor      TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_pay_events_entry ON payment_events (entry_id, created_at);

-- ---------------------------------------------------------------- email_log: new kind, recipients, payment link
-- (rebuilt because SQLite cannot widen a CHECK constraint; nothing references this table)
CREATE TABLE email_log_new (
  id               TEXT PRIMARY KEY,
  client_id        TEXT REFERENCES clients(id),
  lead_id          TEXT REFERENCES leads(id),
  payment_entry_id TEXT REFERENCES payment_entries(id),
  kind             TEXT NOT NULL CHECK (kind IN ('auto_reply', 'owner_alert', 'followup', 'login', 'payment_reminder')),
  resend_id        TEXT,
  status           TEXT NOT NULL,                 -- sent | dry_run | failed | bounced | complained
  recipients       INTEGER NOT NULL DEFAULT 1,    -- Resend counts every recipient as one email
  created_at       TEXT NOT NULL
);
INSERT INTO email_log_new (id, client_id, lead_id, kind, resend_id, status, created_at)
  SELECT id, client_id, lead_id, kind, resend_id, status, created_at FROM email_log;
DROP TABLE email_log;
ALTER TABLE email_log_new RENAME TO email_log;
CREATE INDEX idx_email_log_lead    ON email_log (lead_id);
CREATE INDEX idx_email_log_day     ON email_log (created_at);
CREATE INDEX idx_email_log_payment ON email_log (payment_entry_id);
CREATE INDEX idx_email_log_resend  ON email_log (resend_id);

-- ---------------------------------------------------------------- sending safety
CREATE TABLE system_flags (
  key        TEXT PRIMARY KEY,                    -- pause_all | pause_automated
  value      TEXT NOT NULL,                       -- '1' on, '0' off
  reason     TEXT,
  updated_by TEXT,
  updated_at TEXT NOT NULL
);

-- Every email Resend receives for our domain. Received mail counts toward the same daily/monthly quota as sent mail.
CREATE TABLE inbound_events (
  id           TEXT PRIMARY KEY,                  -- Resend email id
  from_email   TEXT,
  to_email     TEXT,
  matched_kind TEXT,                              -- payment | lead | NULL
  matched_id   TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_inbound_day ON inbound_events (created_at);
