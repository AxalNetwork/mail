-- Newsletters, part 2: audiences read from StudioOS (lists, members, testers),
-- sending limits, and emails to product-testing programmes. Every newsletter
-- now needs an approved version before it can be scheduled.

-- StudioOS audience keys an issue goes to (JSON array, e.g. ["web:brief", "testers:prg_1"]).
ALTER TABLE nl_issues ADD COLUMN audiences TEXT NOT NULL DEFAULT '[]';
-- A testing email belongs to one programme (StudioOS uid) and is one of its kinds (in, not, reminder, survey, thanks).
ALTER TABLE nl_issues ADD COLUMN programme_uid TEXT;
-- Variant of the template, e.g. "online" for an event invitation.
ALTER TABLE nl_issues ADD COLUMN variant TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS nl_issues_programme ON nl_issues (programme_uid);

-- Sending limits: at most daily_limit messages per UTC day, per_minute while sending.
ALTER TABLE nl_settings ADD COLUMN daily_limit INTEGER NOT NULL DEFAULT 400;
ALTER TABLE nl_settings ADD COLUMN per_minute INTEGER NOT NULL DEFAULT 20;
-- The address newsletters are sent from unless an issue picks another (a "Send mail as" address of the sender's grant).
ALTER TABLE nl_settings ADD COLUMN default_from TEXT NOT NULL DEFAULT '';
-- The last successful read over the StudioOS link (for the settings page).
ALTER TABLE nl_settings ADD COLUMN link_read_at INTEGER;
ALTER TABLE nl_settings ADD COLUMN link_lists INTEGER;
ALTER TABLE nl_settings ADD COLUMN link_programmes INTEGER;

-- Recipients read from StudioOS when an issue starts sending: one row per (issue, address),
-- claimed before sending like nl_sends. Their unsubscribe and preference links are StudioOS's.
CREATE TABLE IF NOT EXISTS nl_ext_sends (
  issue_id INTEGER NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE,
  audience TEXT NOT NULL,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  company TEXT NOT NULL DEFAULT '',
  unsubscribe_url TEXT NOT NULL DEFAULT '',
  preferences_url TEXT NOT NULL DEFAULT '',
  one_click_url TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'skipped', 'unconfirmed')),
  error TEXT,
  gmail_message_id TEXT,
  sent_at INTEGER,
  PRIMARY KEY (issue_id, email)
);
CREATE INDEX IF NOT EXISTS nl_ext_sends_status ON nl_ext_sends (issue_id, status);
