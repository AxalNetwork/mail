-- Newsletters: subscribers (website double opt-in, imports, contacts), lists,
-- issues built from template blocks, and one send record per recipient so an
-- issue reaches each person at most once. Issues to lists that need approval
-- (investors and LPs) are approved version by version, bound to a content hash.

CREATE TABLE IF NOT EXISTS nl_subscribers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  company TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'subscribed', 'unsubscribed', 'bounced', 'suppressed')),
  source TEXT NOT NULL DEFAULT 'website' CHECK (source IN ('website', 'import', 'manual', 'contact')),
  -- How consent was given: double_opt_in (confirmed by email), import_attested (an admin attested on import), manual.
  consent_method TEXT,
  consent_at INTEGER,
  frequency TEXT NOT NULL DEFAULT 'all' CHECK (frequency IN ('all', 'essentials')),
  -- Confirmation email: null until sent; the cron sends queued ones.
  confirm_sent_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  unsubscribed_at INTEGER,
  last_sent_at INTEGER
);
CREATE INDEX IF NOT EXISTS nl_subscribers_status ON nl_subscribers (status);

-- Lists: website topics (public = offered on the signup form) and private audiences.
CREATE TABLE IF NOT EXISTS nl_lists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  public INTEGER NOT NULL DEFAULT 0,
  requires_approval INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO nl_lists (key, name, description, public, requires_approval, created_at) VALUES
  ('brief', 'The Axal VC Brief', 'Monthly brief for founders, operators and the ecosystem', 1, 0, 0),
  ('insights', 'Insights', 'Essays and long reads', 1, 0, 0),
  ('events', 'Events', 'Invitations and recaps', 1, 0, 0),
  ('portfolio', 'Portfolio news', 'Spotlights and portfolio milestones', 1, 0, 0),
  ('founders', 'Founders', 'Founders the team works with or follows', 0, 0, 0),
  ('lps', 'LPs & investors', 'Private: partner letters and investor updates', 0, 1, 0);

CREATE TABLE IF NOT EXISTS nl_memberships (
  subscriber_id INTEGER NOT NULL,
  list_id INTEGER NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (subscriber_id, list_id)
);
CREATE INDEX IF NOT EXISTS nl_memberships_list ON nl_memberships (list_id);

CREATE TABLE IF NOT EXISTS nl_issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  template TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  preheader TEXT NOT NULL DEFAULT '',
  -- Header label, e.g. "No. 14 · October 2026".
  edition TEXT NOT NULL DEFAULT '',
  -- JSON: the template's blocks, in order.
  blocks TEXT NOT NULL DEFAULT '[]',
  -- JSON: list ids.
  list_ids TEXT NOT NULL DEFAULT '[]',
  from_email TEXT NOT NULL DEFAULT '',
  from_name TEXT NOT NULL DEFAULT '',
  -- JSON {title, calendarUrl}: the sign-off fills {sender_title} and {calendar_url}.
  signoff TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'in_review', 'approved', 'scheduled', 'sending', 'paused', 'sent', 'cancelled')),
  version INTEGER NOT NULL DEFAULT 1,
  content_hash TEXT NOT NULL DEFAULT '',
  review_requested_by TEXT,
  approved_hash TEXT,
  approved_by TEXT,
  approved_at INTEGER,
  -- Whose Gmail sending grant sends it (set when scheduled).
  sender_member TEXT,
  scheduled_at INTEGER,
  started_at INTEGER,
  sent_at INTEGER,
  recipients INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS nl_issues_status ON nl_issues (status, scheduled_at);

-- One row per (issue, recipient): claimed before sending, so nobody gets an issue twice.
CREATE TABLE IF NOT EXISTS nl_sends (
  issue_id INTEGER NOT NULL,
  subscriber_id INTEGER NOT NULL,
  email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'skipped')),
  error TEXT,
  gmail_message_id TEXT,
  sent_at INTEGER,
  PRIMARY KEY (issue_id, subscriber_id)
);
CREATE INDEX IF NOT EXISTS nl_sends_status ON nl_sends (issue_id, status);

-- Subscriber history: signups, confirmations, preference changes, unsubscribes (with the issue that led to it, if any).
CREATE TABLE IF NOT EXISTS nl_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscriber_id INTEGER,
  issue_id INTEGER,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS nl_events_subscriber ON nl_events (subscriber_id, at);
CREATE INDEX IF NOT EXISTS nl_events_issue ON nl_events (issue_id, kind);

-- People whose data was deleted after unsubscribing: never re-added by an import (SHA-256 of the address).
CREATE TABLE IF NOT EXISTS nl_suppressions (
  email_hash TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  at INTEGER NOT NULL
);

-- Signup rate limit for the public form (hashed client address, per hour).
CREATE TABLE IF NOT EXISTS nl_signup_attempts (
  key TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS nl_signup_attempts_key ON nl_signup_attempts (key, at);

-- One row of settings.
CREATE TABLE IF NOT EXISTS nl_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  postal_address TEXT NOT NULL DEFAULT '',
  disclaimer TEXT NOT NULL DEFAULT '',
  from_name TEXT NOT NULL DEFAULT 'Axal VC',
  -- Member whose sending grant sends confirmation and welcome emails.
  system_sender TEXT,
  system_from TEXT NOT NULL DEFAULT '',
  double_opt_in INTEGER NOT NULL DEFAULT 1,
  batch_size INTEGER NOT NULL DEFAULT 40,
  -- JSON: origins allowed to post the signup form.
  allowed_origins TEXT NOT NULL DEFAULT '["https://axal.vc","https://www.axal.vc"]',
  updated_by TEXT,
  updated_at INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO nl_settings (id) VALUES (1);
