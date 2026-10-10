export interface Env {
  /** Static frontend (the Vite build in dist/). */
  ASSETS: Fetcher;
  /** Shared internal notes. */
  DB: D1Database;
  /** OAuth Web client ID; tokens must be issued to this client. */
  GOOGLE_CLIENT_ID?: string;
  /** Comma-separated email domains allowed to use the API, e.g. "axal.vc". */
  ALLOWED_DOMAINS: string;
  /** Comma-separated member emails with full rights, including granting admin. */
  SUPER_ADMINS?: string;
  /** Domain treated as internal by the frontend. */
  ORG_DOMAIN: string;
  /** Secret. Service account key (JSON) with domain-wide delegation; enables shared mailboxes. */
  GOOGLE_SERVICE_ACCOUNT?: string;
  /** Secret. Enables the assistant endpoints. */
  ANTHROPIC_API_KEY?: string;
}
