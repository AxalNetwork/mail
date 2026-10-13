-- Contacts & Relationships. Records people and organizations the team chose
-- to keep; email history is never copied here (the app reads it from Gmail by
-- thread id when it is shown). `visibility` is 'team' (every member) or
-- 'private' (the creator and the relationship owner only).

CREATE TABLE IF NOT EXISTS organizations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  -- Lowercased, punctuation and legal suffixes removed: "Atlas Systems, Inc." = "atlas systems".
  name_key TEXT NOT NULL,
  domain TEXT NOT NULL DEFAULT '',
  website TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'Other',
  tags TEXT NOT NULL DEFAULT '[]',
  notes TEXT NOT NULL DEFAULT '',
  owner_email TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'team' CHECK (visibility IN ('team', 'private')),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER
);
CREATE INDEX IF NOT EXISTS organizations_name_key ON organizations (name_key);
CREATE INDEX IF NOT EXISTS organizations_domain ON organizations (domain);

CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  organization_id INTEGER REFERENCES organizations (id),
  website TEXT NOT NULL DEFAULT '',
  linkedin TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  notes TEXT NOT NULL DEFAULT '',
  owner_email TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'team' CHECK (visibility IN ('team', 'private')),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER,
  -- Set when this record was merged into another; the row is kept archived.
  merged_into INTEGER
);
CREATE INDEX IF NOT EXISTS contacts_name_key ON contacts (name_key);
CREATE INDEX IF NOT EXISTS contacts_org ON contacts (organization_id);

-- A contact may have several addresses; an address belongs to one live contact.
CREATE TABLE IF NOT EXISTS contact_emails (
  email TEXT PRIMARY KEY,
  contact_id INTEGER NOT NULL REFERENCES contacts (id),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS contact_emails_contact ON contact_emails (contact_id);

-- Introductions and other events someone recorded by hand. Nothing here is inferred.
CREATE TABLE IF NOT EXISTS relationship_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL REFERENCES contacts (id),
  kind TEXT NOT NULL CHECK (kind IN ('introduction', 'meeting', 'note')),
  text TEXT NOT NULL,
  -- Gmail thread id in the recorder's mailbox, when the event came from a conversation.
  thread_id TEXT NOT NULL DEFAULT '',
  occurred_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS relationship_events_contact ON relationship_events (contact_id, occurred_at);
