export interface Env {
  /** Static frontend (the Vite build in dist/). */
  ASSETS: Fetcher;
  /** Shared internal notes. */
  DB: D1Database;
  /** OAuth Web client ID; tokens must be issued to this client. */
  GOOGLE_CLIENT_ID?: string;
  /** Comma-separated email domains allowed to use the API, e.g. "axal.vc". */
  ALLOWED_DOMAINS: string;
  /** Domain treated as internal by the frontend. */
  ORG_DOMAIN: string;
  /** Secret. Enables the assistant endpoints. */
  ANTHROPIC_API_KEY?: string;
}
