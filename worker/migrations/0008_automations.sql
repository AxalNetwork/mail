-- Suggestions a member dismissed (follow-ups, replies, inbox manager), so the
-- same suggestion is not shown again. item_key includes the conversation's
-- last activity, so new messages bring it back.
CREATE TABLE IF NOT EXISTS automation_dismissals (
  member_email TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('follow_up', 'reply', 'triage')),
  item_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (member_email, kind, item_key)
);
