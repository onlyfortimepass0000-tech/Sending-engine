-- Enquiry Engine: initial schema. Every tenant row carries client_id.
-- Timestamps are ISO-8601 UTC strings (sortable, readable in the D1 console).
-- Booleans are INTEGER 0/1.

CREATE TABLE clients (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  slug            TEXT NOT NULL UNIQUE,
  public_key      TEXT NOT NULL UNIQUE,
  allowed_origins TEXT NOT NULL DEFAULT '[]',          -- JSON array of origins; "*" = any
  timezone        TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL
);

CREATE TABLE client_settings (
  client_id  TEXT PRIMARY KEY REFERENCES clients(id),
  settings   TEXT NOT NULL DEFAULT '{}',               -- JSON, validated by src/lib/settings.ts
  updated_at TEXT NOT NULL
);

CREATE TABLE leads (
  id                TEXT PRIMARY KEY,
  client_id         TEXT NOT NULL REFERENCES clients(id),
  name              TEXT,
  email             TEXT NOT NULL,
  phone             TEXT,
  message           TEXT,
  extras            TEXT,                              -- JSON: any non-mapped form fields
  source            TEXT NOT NULL DEFAULT 'direct',    -- label used for "conversion by source"
  source_meta       TEXT,                              -- JSON: utm_*, referrer, form tag, page
  category          TEXT,                              -- set by sorting (Stage 2)
  urgency           TEXT CHECK (urgency IN ('low', 'normal', 'high')),
  summary           TEXT,
  status            TEXT NOT NULL DEFAULT 'new'
                    CHECK (status IN ('new', 'contacted', 'booked', 'won', 'lost', 'not_interested', 'unsubscribed')),
  has_phone         INTEGER NOT NULL DEFAULT 0,
  consent_text      TEXT NOT NULL,
  consent_at        TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  first_response_at TEXT
);
CREATE INDEX idx_leads_client_created ON leads (client_id, created_at);
CREATE INDEX idx_leads_dedupe         ON leads (client_id, email, created_at);
CREATE INDEX idx_leads_client_status  ON leads (client_id, status);

CREATE TABLE sequence_jobs (
  id              TEXT PRIMARY KEY,
  client_id       TEXT NOT NULL REFERENCES clients(id),
  lead_id         TEXT NOT NULL REFERENCES leads(id),
  step            INTEGER NOT NULL,
  due_at          TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'skipped', 'failed')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT NOT NULL UNIQUE
);
CREATE INDEX idx_jobs_due  ON sequence_jobs (status, due_at);
CREATE INDEX idx_jobs_lead ON sequence_jobs (lead_id);

CREATE TABLE email_log (
  id         TEXT PRIMARY KEY,
  client_id  TEXT NOT NULL REFERENCES clients(id),
  lead_id    TEXT NOT NULL REFERENCES leads(id),
  kind       TEXT NOT NULL CHECK (kind IN ('auto_reply', 'owner_alert', 'followup')),
  resend_id  TEXT,
  status     TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_email_log_lead ON email_log (lead_id);
CREATE INDEX idx_email_log_day  ON email_log (created_at);

CREATE TABLE suppressions (
  client_id TEXT NOT NULL REFERENCES clients(id),
  email     TEXT NOT NULL,
  reason    TEXT NOT NULL,                             -- unsubscribe | bounce | complaint | manual
  PRIMARY KEY (client_id, email)
);

-- Dashboard login. users.client_id is NULL for ATOMZ admins.
CREATE TABLE users (
  id         TEXT PRIMARY KEY,
  client_id  TEXT REFERENCES clients(id),
  email      TEXT NOT NULL UNIQUE,
  role       TEXT NOT NULL CHECK (role IN ('admin', 'client')),
  created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,                         -- sha-256 of the session cookie value
  user_id    TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE magic_links (
  id          TEXT PRIMARY KEY,                        -- sha-256 of the emailed token
  user_id     TEXT NOT NULL REFERENCES users(id),
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  created_at  TEXT NOT NULL
);

-- Fixed-window counters for intake rate limiting. bucket = "ip:<hash>" or "key:<public_key>".
CREATE TABLE rate_limits (
  bucket       TEXT NOT NULL,
  window_start INTEGER NOT NULL,                       -- epoch seconds, floored to the window length
  count        INTEGER NOT NULL,
  PRIMARY KEY (bucket, window_start)
) WITHOUT ROWID;
