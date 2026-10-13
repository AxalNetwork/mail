-- Tasks & Approvals: email-related tasks (optionally linked to a GitHub issue
-- in one of the firm's repositories), and an approval queue for consequential
-- actions. Approvals are bound to a content hash: changing the content after
-- approval puts it back to pending.

-- GitHub repositories whose issues show in Tasks. Super admins edit the list.
CREATE TABLE IF NOT EXISTS task_repos (
  full_name TEXT PRIMARY KEY COLLATE NOCASE,
  added_by TEXT NOT NULL,
  added_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO task_repos (full_name, added_by, added_at) VALUES
  ('AxalNetwork/mail', 'migration', 0),
  ('AxalNetwork/StudioOS', 'migration', 0),
  ('DeFiScoring/website', 'migration', 0),
  ('GeneratedArt/platform', 'migration', 0),
  ('Scenographist/scenographist', 'migration', 0),
  ('GenerativeFinance/gefi', 'migration', 0),
  ('AlgoSize/platform', 'migration', 0),
  ('CatalystPod/platform', 'migration', 0),
  ('Tokenomic-org/website', 'migration', 0);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  assignee TEXT,
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'waiting', 'completed', 'cancelled')),
  -- Only when the user set one.
  due_at INTEGER,
  created_via TEXT NOT NULL DEFAULT 'manual' CHECK (created_via IN ('manual', 'ai_suggested', 'automation', 'github')),
  -- The email it came from (thread ids are per mailbox). The subject is kept so the list reads without Gmail.
  source_mailbox TEXT NOT NULL DEFAULT '',
  source_thread_id TEXT NOT NULL DEFAULT '',
  source_subject TEXT NOT NULL DEFAULT '',
  github_repo TEXT,
  github_number INTEGER,
  github_url TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS tasks_assignee ON tasks (assignee, status);
CREATE INDEX IF NOT EXISTS tasks_creator ON tasks (created_by, status);
CREATE INDEX IF NOT EXISTS tasks_source ON tasks (source_mailbox, source_thread_id);
-- One task per GitHub issue.
CREATE UNIQUE INDEX IF NOT EXISTS tasks_github ON tasks (github_repo COLLATE NOCASE, github_number) WHERE github_repo IS NOT NULL;

CREATE TABLE IF NOT EXISTS task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS task_events_task ON task_events (task_id, at);

CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('email_draft', 'bulk_campaign', 'shared_reply')),
  title TEXT NOT NULL,
  -- JSON of the proposed action, exactly what will be executed.
  payload TEXT NOT NULL,
  -- SHA-256 of the payload; a decision and an execution must name it.
  content_hash TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'deferred', 'executing', 'executed', 'failed', 'withdrawn')),
  requester TEXT NOT NULL,
  reviewer TEXT,
  note TEXT NOT NULL DEFAULT '',
  -- Shared mailbox it acts on (shared_reply), else ''.
  mailbox TEXT NOT NULL DEFAULT '',
  source_thread_id TEXT NOT NULL DEFAULT '',
  -- The hash that was approved; must equal content_hash to execute.
  approved_hash TEXT,
  requested_at INTEGER NOT NULL,
  decided_at INTEGER,
  executed_by TEXT,
  executed_at INTEGER,
  result TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS approvals_status ON approvals (status, requested_at);
CREATE INDEX IF NOT EXISTS approvals_requester ON approvals (requester, requested_at);

CREATE TABLE IF NOT EXISTS approval_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  approval_id INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  version INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS approval_events_approval ON approval_events (approval_id, at);

-- When each member last looked at their Tasks notifications.
CREATE TABLE IF NOT EXISTS task_inbox_seen (
  member_email TEXT PRIMARY KEY,
  seen_at INTEGER NOT NULL
);
