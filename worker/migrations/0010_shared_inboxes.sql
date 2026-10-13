-- Shared Inboxes: who handles a conversation, its team status, who is looking
-- at it, and a log of consequential actions. Message content is never stored;
-- conversations are identified by the shared mailbox's Gmail thread id.

-- Members with access may read and draft; only those with can_send may send as the mailbox.
ALTER TABLE mailbox_access ADD COLUMN can_send INTEGER NOT NULL DEFAULT 1;

-- Application state, separate from Gmail's (read/unread, labels, archive are untouched).
CREATE TABLE IF NOT EXISTS shared_conversations (
  mailbox TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'pending', 'resolved')),
  assignee TEXT,
  -- Optimistic concurrency: a change must name the version it was made from.
  version INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  last_reply_by TEXT,
  last_reply_at INTEGER,
  PRIMARY KEY (mailbox, thread_id)
);
CREATE INDEX IF NOT EXISTS shared_conversations_assignee ON shared_conversations (mailbox, assignee);

CREATE TABLE IF NOT EXISTS shared_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mailbox TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('assigned', 'claimed', 'released', 'unassigned', 'status', 'replied', 'send_refused')),
  -- The assignee, the new status, the send-as address, or why a send was refused. Never message text.
  detail TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS shared_activity_thread ON shared_activity (mailbox, thread_id, created_at);

-- Heartbeats from open readers and composers; rows older than two minutes are ignored.
CREATE TABLE IF NOT EXISTS shared_presence (
  mailbox TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  member_email TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('viewing', 'replying')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (mailbox, thread_id, member_email)
);
