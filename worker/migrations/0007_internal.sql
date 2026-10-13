-- Internal: notes and comments on conversations, @mentions, and an activity
-- log. Still keyed by the conversation's root Message-ID (see 0001).
ALTER TABLE notes ADD COLUMN kind TEXT NOT NULL DEFAULT 'note' CHECK (kind IN ('note', 'comment'));
ALTER TABLE notes ADD COLUMN subject TEXT NOT NULL DEFAULT '';
ALTER TABLE notes ADD COLUMN updated_at INTEGER;
ALTER TABLE notes ADD COLUMN deleted_at INTEGER;
CREATE INDEX IF NOT EXISTS notes_recent ON notes (created_at);

CREATE TABLE IF NOT EXISTS note_mentions (
  note_id INTEGER NOT NULL REFERENCES notes (id) ON DELETE CASCADE,
  member_email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  read_at INTEGER,
  PRIMARY KEY (note_id, member_email)
);
CREATE INDEX IF NOT EXISTS note_mentions_member ON note_mentions (member_email, read_at);

-- Who did what, when. No note text: the note itself is the record.
CREATE TABLE IF NOT EXISTS note_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_key TEXT NOT NULL,
  note_id INTEGER,
  actor_email TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('created', 'edited', 'deleted', 'mentioned')),
  target_email TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS note_activity_thread ON note_activity (thread_key, created_at);
