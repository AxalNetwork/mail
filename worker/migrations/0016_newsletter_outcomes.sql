-- Newsletters, part 3: what happened after sending (replies, bounce notices,
-- unsubscribe replies, read from the sending mailbox), the events reported back
-- to StudioOS, and approval bound to the exact email.

-- The Gmail thread of each send, and what the sending mailbox shows in it since.
ALTER TABLE nl_sends ADD COLUMN thread_id TEXT;
ALTER TABLE nl_sends ADD COLUMN outcome TEXT CHECK (outcome IN ('replied', 'bounced', 'opted_out'));
ALTER TABLE nl_sends ADD COLUMN checked_at INTEGER;
ALTER TABLE nl_ext_sends ADD COLUMN thread_id TEXT;
ALTER TABLE nl_ext_sends ADD COLUMN outcome TEXT CHECK (outcome IN ('replied', 'bounced', 'opted_out'));
ALTER TABLE nl_ext_sends ADD COLUMN checked_at INTEGER;
CREATE INDEX IF NOT EXISTS nl_sends_watch ON nl_sends (status, checked_at);
CREATE INDEX IF NOT EXISTS nl_ext_sends_watch ON nl_ext_sends (status, checked_at);

-- SHA-256 of the email as approved (sample recipient), so a change to the footer
-- or sender settings after approval needs approval again.
ALTER TABLE nl_issues ADD COLUMN approved_render TEXT;

-- Unsubscribes, bounces and complaints for StudioOS's lists, delivered with
-- retries (backoff) and never twice: one row per event, keyed by message id.
CREATE TABLE IF NOT EXISTS nl_link_events (
  event_id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('unsubscribe', 'bounce', 'complaint')),
  email TEXT NOT NULL,
  audience TEXT NOT NULL DEFAULT '',
  message_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL,
  sent_at INTEGER,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS nl_link_events_due ON nl_link_events (sent_at, next_at);

-- Unsubscribe emails (the List-Unsubscribe mailto) already handled, by Gmail message id.
CREATE TABLE IF NOT EXISTS nl_inbound (
  message_id TEXT PRIMARY KEY,
  at INTEGER NOT NULL
);
