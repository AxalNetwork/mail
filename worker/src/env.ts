export interface Env {
  /** Static frontend (the Vite build in dist/). */
  ASSETS: Fetcher;
  /** Shared internal notes. */
  DB: D1Database;
  /** OAuth Web client ID; tokens must be issued to this client. */
  GOOGLE_CLIENT_ID?: string;
  /** Same as GOOGLE_CLIENT_ID (either name works). */
  GMAIL_CLIENT_ID?: string;
  /** Secret. OAuth client secret, used with GMAIL_REFRESH_TOKEN. */
  GMAIL_CLIENT_SECRET?: string;
  /** Secret. Refresh token for one Workspace mailbox, which can then be shared with members. */
  GMAIL_REFRESH_TOKEN?: string;
  /** Comma-separated email domains allowed to use the API, e.g. "axal.vc". */
  ALLOWED_DOMAINS: string;
  /** Comma-separated member emails with full rights, including granting admin. */
  SUPER_ADMINS?: string;
  /** Domain treated as internal by the frontend. */
  ORG_DOMAIN: string;
  /** Secret. Service account key (JSON) with domain-wide delegation; enables shared mailboxes. */
  GOOGLE_SERVICE_ACCOUNT?: string;
  /** Secret. OAuth client secret: exchanges "Connect sending" grants for refresh tokens. */
  GOOGLE_CLIENT_SECRET?: string;
  /** Secret. 32 random bytes, base64: encrypts stored sending grants. */
  TOKEN_ENCRYPTION_KEY?: string;
  /** Secret. GitHub token that may create issues; enables in-app bug reports. */
  GITHUB_TOKEN?: string;
  /** owner/repo that bug reports go to (default AxalNetwork/mail). */
  GITHUB_REPO?: string;
  /** Secret. Enables the assistant endpoints. */
  ANTHROPIC_API_KEY?: string;
}
