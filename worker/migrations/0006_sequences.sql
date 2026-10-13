-- Investor outreach sequences: approved, scheduled follow-ups sent by the
-- Worker (cron) with each sender's own Gmail credentials.

-- A member's offline Gmail grant (gmail.send + gmail.readonly), encrypted
-- with TOKEN_ENCRYPTION_KEY. Revoked rows are deleted.
CREATE TABLE IF NOT EXISTS sender_credentials (
  member_email TEXT PRIMARY KEY,
  google_email TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  scope TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sequences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_email TEXT NOT NULL,
  name TEXT NOT NULL,
  -- draft → (approve) → approved → (start) → active ⇄ paused → completed / stopped
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'active', 'paused', 'completed', 'stopped')),
  -- Every edit bumps the version and clears the approval.
  version INTEGER NOT NULL DEFAULT 1,
  approved_version INTEGER,
  approved_by TEXT,
  approved_at INTEGER,
  signature_html TEXT NOT NULL DEFAULT '',
  signature_text TEXT NOT NULL DEFAULT '',
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sequences_owner ON sequences (owner_email);

CREATE TABLE IF NOT EXISTS sequence_steps (
  sequence_id INTEGER NOT NULL REFERENCES sequences (id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  -- Days after the previous step (0 for the first step: as soon as the sequence starts).
  delay_days INTEGER NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (sequence_id, position)
);

CREATE TABLE IF NOT EXISTS sequence_enrollments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sequence_id INTEGER NOT NULL REFERENCES sequences (id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  company TEXT NOT NULL DEFAULT '',
  context TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'replied', 'opted_out', 'bounced', 'stopped', 'completed', 'failed')),
  next_step INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER,
  thread_id TEXT,
  last_message_id TEXT,
  references_header TEXT,
  first_sent_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (sequence_id, email)
);
CREATE INDEX IF NOT EXISTS sequence_enrollments_due ON sequence_enrollments (status, next_at);

-- One row per (enrollment, step): the claim that makes a send happen at most once.
CREATE TABLE IF NOT EXISTS sequence_sends (
  enrollment_id INTEGER NOT NULL REFERENCES sequence_enrollments (id) ON DELETE CASCADE,
  step INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sending', 'sent', 'failed')),
  gmail_message_id TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (enrollment_id, step)
);

-- Addresses that asked not to be contacted; checked before every send.
CREATE TABLE IF NOT EXISTS opt_outs (
  email TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
