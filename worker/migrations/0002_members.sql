-- Axal VC members. Anyone with a verified address on an allowed domain
-- (ALLOWED_DOMAINS) may sign in; a row here sets their display name or
-- suspends them. Personal Google accounts sign in only through linked_accounts.
CREATE TABLE IF NOT EXISTS members (
  email TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at INTEGER NOT NULL
);

-- A personal Google account (e.g. name@gmail.com) linked to a member profile.
CREATE TABLE IF NOT EXISTS linked_accounts (
  google_email TEXT PRIMARY KEY,
  member_email TEXT NOT NULL REFERENCES members (email) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS linked_accounts_member ON linked_accounts (member_email);
