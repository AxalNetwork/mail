-- Bug reports filed from the app as GitHub issues. The repository is public,
-- so the issue never names the reporter; this table keeps who filed what.
CREATE TABLE IF NOT EXISTS bug_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_number INTEGER NOT NULL,
  issue_url TEXT NOT NULL,
  member_email TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bug_reports_member ON bug_reports (member_email, created_at);
