-- Snooze: a conversation leaves the inbox (Gmail label "Snoozed", INBOX
-- removed) until `until`, then returns. Gmail's API has no snooze, so the
-- wake-up time is kept here. No message content is stored.
CREATE TABLE IF NOT EXISTS snoozes (
  -- The Google account's address for a personal mailbox, or the shared mailbox.
  mailbox TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  until INTEGER NOT NULL,
  label_id TEXT NOT NULL,
  -- Latest message when snoozed: anything newer from someone else wakes it early.
  last_message_id TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (mailbox, thread_id)
);
CREATE INDEX IF NOT EXISTS snoozes_due ON snoozes (until);

-- Shared inbox activity may now record snoozes too (SQLite can't widen a CHECK in place).
CREATE TABLE shared_activity_next (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mailbox TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('assigned', 'claimed', 'released', 'unassigned', 'status', 'replied', 'send_refused', 'snoozed', 'unsnoozed', 'woke')),
  detail TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
INSERT INTO shared_activity_next (id, mailbox, thread_id, actor, action, detail, created_at)
  SELECT id, mailbox, thread_id, actor, action, detail, created_at FROM shared_activity;
DROP TABLE shared_activity;
ALTER TABLE shared_activity_next RENAME TO shared_activity;
CREATE INDEX IF NOT EXISTS shared_activity_thread ON shared_activity (mailbox, thread_id, created_at);
