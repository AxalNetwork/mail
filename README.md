# Axal VC Mail

Axal VC's email client, built from the Claude Design prototypes: sign-in, mailbox, thread reader, AI assistant panel, composer (send-as identities, send review, templates, internal notes), bulk email (CSV → personas → per-person preview → send), and the standard email signature.

It is one Cloudflare Worker at **https://mail.axal.vc**:

| Part | What it does | Code |
| --- | --- | --- |
| **Frontend** | React app served as static assets. Reads and sends mail straight from the browser through the Gmail and People APIs with the user's Google token. | `src/` |
| **Backend** (`/api/*`) | Confirms that a Google account belongs to an active Axal VC member, runs the Claude-powered assistant, and stores internal notes the whole team can see. | `worker/` |
| **Database** | Cloudflare D1 `axal-mail`: members, linked Google accounts, notes. | `worker/migrations/` |

Without a Google client ID, the app runs as a **demo**: sign-in is simulated, the data is fictional, and nothing is delivered.

## Run it locally

```bash
npm install
npm run dev            # frontend only, http://localhost:5173 (demo unless VITE_GOOGLE_CLIENT_ID is set)
npm run dev:api        # frontend + backend through the Worker, http://localhost:8787
```

`npm run dev` forwards `/api` to `:8787`, so with `dev:api` running in another terminal you get hot reload *and* the backend. For local secrets, put `ANTHROPIC_API_KEY=…` in `.dev.vars` (git-ignored), and pass the client ID with `npx wrangler dev --var GOOGLE_CLIENT_ID:…`.

| Script | |
| --- | --- |
| `npm run build` | Typecheck frontend and Worker, then build `dist/` |
| `npm test` | Unit tests: frontend libraries, Gmail provider (mocked Google), Worker (mocked Google and Claude, real SQL) |
| `npm run deploy` | Build, apply D1 migrations, deploy to Cloudflare |
| `npm run db:migrate` | Apply D1 migrations to the remote database |

## Deploy to mail.axal.vc

Already done in the Cloudflare account: the D1 database `axal-mail` exists (id in `wrangler.jsonc`) and its tables are created.

Still needed, once:

1. **The `axal.vc` zone must be on this Cloudflare account.** `wrangler.jsonc` declares `mail.axal.vc` as a Workers custom domain, so the first deploy creates the DNS record and TLS certificate itself. If `axal.vc`'s DNS lives elsewhere, move the zone to Cloudflare first (custom domains need it).
2. **Google OAuth client** (see below). Add `https://mail.axal.vc` to its *Authorized JavaScript origins*.
3. **GitHub repository settings** (Settings → Secrets and variables → Actions):

   | Name | Kind | Value |
   | --- | --- | --- |
   | `CLOUDFLARE_API_TOKEN` | Secret | API token with *Workers Scripts: Edit*, *Workers Routes: Edit*, *D1: Edit* and *Zone → DNS: Edit* on `axal.vc` (the "Edit Cloudflare Workers" template plus D1) |
   | `CLOUDFLARE_ACCOUNT_ID` | Secret | The account that owns the `axal-mail` D1 database |
   | `ANTHROPIC_API_KEY` | Secret | Enables the assistant (summaries, drafts, rewrites, bulk persona messages) |
   | `GOOGLE_CLIENT_ID` | Variable | The OAuth Web client ID (public) |

4. Push to the default branch. `.github/workflows/deploy.yml` tests everything, applies migrations, deploys the Worker with the frontend, sets the Anthropic key, and checks `https://mail.axal.vc/api/health`.

To deploy by hand instead: `npx wrangler login`, then `npm run deploy` and `npx wrangler secret put ANTHROPIC_API_KEY`.

Configuration lives in the Worker, not in the build: the frontend reads `/api/config` at startup, so changing the client ID or enabling the assistant needs no rebuild.

| Worker setting | Where | |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` | var (`--var` at deploy, or `wrangler.jsonc`) | OAuth client the API accepts tokens for |
| `ALLOWED_DOMAINS` | var, default `axal.vc` | Email domains whose verified accounts are members |
| `ORG_DOMAIN` | var, default `axal.vc` | Domain the composer treats as internal |
| `ANTHROPIC_API_KEY` | secret | Assistant; without it the assistant endpoints answer 503 and the UI falls back to templates |

## Google OAuth client

1. Create a Google Cloud project at <https://console.cloud.google.com/> and enable the **Gmail API** and **People API**.
2. OAuth consent screen: for the Axal VC Workspace, choose **Internal**, so only the organization signs in and Google's app verification isn't required. Linked *personal* Gmail accounts (below) need **External**. There, `gmail.modify` is a restricted scope: test users work right away, but publishing needs Google's verification.
3. Credentials → Create OAuth client ID → *Web application*. Authorized JavaScript origins: `https://mail.axal.vc` and `http://localhost:5173` / `http://localhost:8787` for development. No redirect URI is needed.

| Scope | Used for |
| --- | --- |
| `openid`, `email`, `profile` | Who is signed in; name and photo for the signature |
| `gmail.modify` | Read threads, mark read, star, archive, trash, send, drafts |
| `gmail.settings.basic` | Send-as addresses; installing the standard signature |
| `contacts.readonly`, `contacts.other.readonly` | Recipient autocomplete |

## Sign-in

The login screen follows the design:

- **Continue** with an `@axal.vc` address opens Google sign-in for that address.
- **Continue with Google** opens Google's account chooser, for a personal Gmail that is linked to a member profile.
- After Google, the app calls `GET /api/session`. The Worker verifies the token with Google, checks that it was issued to this OAuth client, and resolves the account:
  - an address on `ALLOWED_DOMAINS` is a member unless `members.status` is `suspended`;
  - any other address must be in `linked_accounts`; otherwise the screen shows *This Google account isn't linked to Axal VC*.
- A session lasts at most **12 hours**; then the login screen asks the user to sign in again. Google access tokens (about one hour) are refreshed silently in between. The token is kept in `sessionStorage`; only the last address and the session start time go in `localStorage`.

Members and linked accounts are rows in D1; add them with the Cloudflare dashboard (D1 → axal-mail → Console) or `wrangler d1 execute axal-mail --remote --command "…"`:

```sql
-- Optional for @axal.vc staff (needed only to set a display name or suspend someone)
INSERT INTO members (email, name, status, created_at) VALUES ('julian@axal.vc', 'Julian Park', 'active', unixepoch() * 1000);
-- Let a personal Gmail sign in as that member
INSERT INTO linked_accounts (google_email, member_email, created_at) VALUES ('julian.park@gmail.com', 'julian@axal.vc', unixepoch() * 1000);
-- Suspend
UPDATE members SET status = 'suspended' WHERE email = 'julian@axal.vc';
```

A suspension applies to new sign-ins at once, and to open sessions within 5 minutes.

## Backend API

All endpoints except `config` and `health` need `Authorization: Bearer <Google access token>` from an active member. Writes from other origins are refused.

| Endpoint | |
| --- | --- |
| `GET /api/config` | Public settings for the frontend |
| `GET /api/health` | Liveness |
| `GET /api/session` | The member behind the token, or `403` with `code: not_linked` / `suspended` |
| `GET /api/notes?key=<Message-ID>` · `POST /api/notes` | Internal notes for a conversation. They are keyed by the first message's `Message-ID`, which is the same in every teammate's mailbox (Gmail thread IDs are not). |
| `POST /api/assistant/insight` | Summary, extracted points, suggested reply |
| `POST /api/assistant/draft` | Draft from an instruction and/or the thread |
| `POST /api/assistant/rewrite` | `shorter`, `formal`, `warmer`, `clarity`, `translate` (French) |
| `POST /api/assistant/persona` | Bulk email subject and body for one persona, with merge tokens |

The assistant uses Claude Opus 5.5 through the Anthropic SDK, with JSON-schema structured outputs and server-side refusal fallback (`fallbacks: "default"`). The system prompt treats email content as untrusted data (it never follows instructions found in messages), forbids inventing facts, and keeps investment or fund-term commitments out of drafts. The model returns plain-text paragraphs and the Worker builds the HTML, escaped, so nothing it writes can inject markup into the composer.

## How the design maps to Gmail

| Feature | Behavior |
| --- | --- |
| Inbox tabs | *Primary* (`category:primary`), your top-level Gmail labels, and *Updates* |
| Starred / Sent / Drafts / All Mail / Search | Gmail labels, drafts and search syntax. Clicking a draft reopens it in the composer. |
| Snoozed / Scheduled | Listed with `in:snoozed` / `in:scheduled`. **Snoozing and scheduling a send are disabled**: the Gmail API has no endpoints for them. |
| Reply / Reply all / Forward | Threaded with `threadId`, `In-Reply-To` and `References`. Reply all drops your own addresses. Forward can re-attach the original files. |
| From / send-as | Your Gmail send-as addresses |
| Drafts | Autosaved to Gmail. Sending a draft updates it, then sends it. |
| Send review | External recipients plus confidential files, fund-term wording, send-as, more than 10 recipients |
| Internal notes | Shared with the team through the backend; never included in the email |
| Bulk email | One message per recipient, about 30 per minute. Investor and LP personas are saved to Drafts for partner approval. |
| Signature | From your Google profile, with missing fields editable under *Administration*. **Install in Gmail** writes it to Gmail's signature setting. |
| HTML mail | Sandboxed iframe (no scripts); remote images blocked until *Show images* |
| Mailbox switcher, document library, delegated mailboxes | Demo only. Delegated access needs Workspace domain-wide delegation. |

Security headers for the frontend (CSP limited to Google's endpoints, HSTS, no framing) are in `public/_headers`.

## Code map

```
src/                      Frontend
  App.tsx                 Config loading, login vs demo vs Gmail session
  signIn.ts               Google sign-in + member check (and the simulated demo sign-in)
  MailApp.tsx             App shell: folders, list, reader, assistant, composer wiring
  config.ts               Runtime config from /api/config (VITE_* fallback)
  providers/
    types.ts              MailProvider interface + capability flags
    demo/                 In-memory provider and sample data
    gmail/                Google auth (12-hour sessions), REST client, parsing, GmailProvider, notes stores
  assistant/              Demo, offline and HTTP (backend) assistant implementations
  lib/                    Pure logic: CSV, bulk merge, send checks, MIME builder, signature HTML
  components/             LoginScreen, Header, Sidebar, ThreadList, ThreadReader, AssistantPanel,
                          composer/, bulk/, admin/
  styles/app.css          Design tokens and component styles
worker/                   Backend (Cloudflare Worker)
  src/index.ts            Router; non-/api paths are served from dist/ by Cloudflare
  src/auth.ts             Google token verification and member resolution
  src/assistant.ts        Claude calls and prompts
  src/notes.ts            D1 notes
  migrations/             D1 schema
wrangler.jsonc            Worker, assets, custom domain, D1 binding
public/_headers           Security headers for the static frontend
```
