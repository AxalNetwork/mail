-- Shared mailboxes (e.g. deals@axal.vc) a member may open in Axal VC Mail.
-- The Worker reads them through Google Workspace domain-wide delegation
-- (GOOGLE_SERVICE_ACCOUNT); access is granted per member by a super admin.
CREATE TABLE IF NOT EXISTS mailbox_access (
  mailbox TEXT NOT NULL,
  member_email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (mailbox, member_email)
);
CREATE INDEX IF NOT EXISTS mailbox_access_member ON mailbox_access (member_email);
