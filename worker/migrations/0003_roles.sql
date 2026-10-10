-- Roles. `admin` manages members and linked accounts; super admins (the
-- SUPER_ADMINS var, so they can't be locked out from the app) also grant and
-- revoke admin.
ALTER TABLE members ADD COLUMN role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin'));
