-- Documents: files live in each member's Google Drive (scope drive.file: only
-- files Axal VC Mail created). D1 keeps the app's metadata and AI extraction
-- results, never file contents. Drive file ids are the canonical identifiers.

CREATE TABLE IF NOT EXISTS drive_settings (
  member_email TEXT PRIMARY KEY,
  google_email TEXT NOT NULL,
  -- The "Axal VC Mail" folder this app created in the member's Drive.
  root_folder_id TEXT NOT NULL,
  -- JSON: [{ "name": "Pitch Decks", "folderId": "…" }, …]
  categories TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_email TEXT NOT NULL,
  drive_file_id TEXT NOT NULL,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT '',
  size INTEGER,
  category TEXT NOT NULL DEFAULT '',
  folder_id TEXT NOT NULL DEFAULT '',
  -- Where it came from, when saved from an email (thread ids are per mailbox).
  source_mailbox TEXT NOT NULL DEFAULT '',
  source_thread_id TEXT NOT NULL DEFAULT '',
  source_message_id TEXT NOT NULL DEFAULT '',
  -- Makes saving the same attachment twice return the first copy.
  source_key TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  -- Set when the file is gone from Drive (trashed or deleted there).
  missing_at INTEGER,
  extraction_status TEXT NOT NULL DEFAULT 'none' CHECK (extraction_status IN ('none', 'done', 'failed')),
  extraction TEXT,
  extracted_at INTEGER,
  UNIQUE (member_email, drive_file_id),
  UNIQUE (member_email, source_key)
);
CREATE INDEX IF NOT EXISTS documents_source ON documents (member_email, source_message_id);
