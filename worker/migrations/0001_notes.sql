-- Internal notes: team-only comments attached to a conversation, never sent.
-- thread_key is the RFC 5322 Message-ID of the conversation's first message,
-- which is the same in every team member's mailbox (Gmail thread IDs are not).
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_key TEXT NOT NULL,
  author_email TEXT NOT NULL,
  author_name TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS notes_thread_key ON notes (thread_key, created_at);
