# Axal VC Mail

Axal VC's email client, built from the Claude Design prototypes: sign-in, mailbox, thread reader, AI assistant panel, composer (send-as identities, send review, templates, internal notes), bulk email (CSV → personas → per-person preview → send), and the standard email signature.

It is one Cloudflare Worker at **https://mail.axal.vc**:

| Part | What it does | Code |
| --- | --- | --- |
| **Frontend** | React app served as static assets. Reads and sends mail straight from the browser through the Gmail and People APIs with the user's Google token. | `src/` |
| **Backend** (`/api/*`) | Confirms that a Google account belongs to an active Axal VC member, runs the Claude-powered assistant, and stores internal notes the whole team can see. | `worker/` |
| **Database** | Cloudflare D1 `axal-mail`: members, linked Google accounts, notes. | `worker/migrations/` |

This is a real mail client: only verified Google accounts of active Axal VC members get in, and each sees their own Gmail. A deployment without a Google client ID lets nobody in ("Sign-in isn't set up yet"). The demo (simulated sign-in, fictional data, nothing delivered) exists only in local development with `npm run dev`.

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
   | `GOOGLE_CLIENT_ID` | Variable or secret | The OAuth Web client ID (public) |

4. Push to the default branch. `.github/workflows/deploy.yml` tests everything, applies migrations, deploys the Worker with the frontend, sets the Anthropic key, and checks `https://mail.axal.vc/api/health`.

**Deploying from Cloudflare instead of GitHub Actions:** connecting the repository under Workers & Pages → mail → Settings → Build works as is: `wrangler deploy` runs the frontend build itself (`build.command` in `wrangler.jsonc`), and no API token is needed. Use one pipeline or the other; if you use Cloudflare's, delete the `CLOUDFLARE_API_TOKEN` secret so GitHub doesn't deploy too. Set `GOOGLE_CLIENT_ID` either under the Worker's Settings → Variables and secrets (deploys keep it, `keep_vars`) or under Settings → Build → Variables and secrets. A build variable is captured into `dist/build-config.json` and the Worker falls back to it, so it applies from the next build. Cloudflare's build doesn't apply D1 migrations; run `npm run db:migrate` when a new one is added.

The Worker is named `mail` (`wrangler.jsonc`), so the deploy replaces a `mail` Worker created in the dashboard.

**Nothing at mail.axal.vc?** Attach the domain as a Worker **custom domain**, not a DNS record. A CNAME from `mail.axal.vc` to `*.workers.dev` is not served. Delete any `mail` CNAME/A record under DNS → Records; then the deploy (or Workers & Pages → mail → Settings → Domains & Routes → Add → Custom domain) creates the right record.

To deploy by hand instead: `npx wrangler login`, then `npm run deploy` and `npx wrangler secret put ANTHROPIC_API_KEY`.

Configuration lives in the Worker, not in the build: the frontend reads `/api/config` at startup, so changing the client ID or enabling the assistant needs no rebuild.

| Worker setting | Where | |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` (or `GMAIL_CLIENT_ID`) | var or secret | OAuth client the API accepts tokens for, and the one sign-in uses |
| `ALLOWED_DOMAINS` | var, default `axal.vc` | Email domains whose verified accounts are members |
| `ORG_DOMAIN` | var, default `axal.vc` | Domain the composer treats as internal |
| `SUPER_ADMINS` | var, `guillaume.lauzier@axal.vc` | Members with full rights in *Members & access*. They can't be suspended or demoted from the app. |
| `ANTHROPIC_API_KEY` | secret | Assistant; without it the assistant endpoints answer 503 and the UI falls back to templates |
| `GOOGLE_SERVICE_ACCOUNT` | secret | Service account key (JSON) with domain-wide delegation; enables shared mailboxes |
| `GITHUB_TOKEN` | secret (or the `BUG_REPORTS_TOKEN` GitHub secret, which the deploy copies) | Enables *Report a bug* (account menu): a fine-grained token with **Issues: Read and write** on the repository |
| `GITHUB_REPO` | var, default `AxalNetwork/mail` | Where bug reports are filed |
| `GMAIL_REFRESH_TOKEN` + `GMAIL_CLIENT_SECRET` | secrets | Instead of a service account: a refresh token (gmail.modify, issued to the client ID) for one mailbox, which super admins can then share |

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

## Roles, members and mailboxes

Every person opens **their own Gmail mailbox** when they sign in. Administration → **Members & access** (visible to admins) manages the rest:

| Role | Can |
| --- | --- |
| Member | Use their own mailbox, and any shared mailbox they were given |
| Admin | Add and rename members, suspend and restore members, link personal Google accounts |
| Super admin (`SUPER_ADMINS`) | Everything an admin can, plus grant or revoke admin, suspend admins, and decide who opens which shared mailbox |

Nobody changes their own role or status from the app.

### Shared mailboxes (deals@, ir@…)

A super admin can give members access to another Workspace mailbox; it then appears in the **Mailbox** menu at the top. The Worker reads it with Google Workspace **domain-wide delegation**; the browser never gets that mailbox's credentials, and the Worker only lets through what the mail client does (read, label, archive, trash, drafts, send), not deletes, filters, forwarding or settings.

For a single mailbox, a refresh token is enough: put `GMAIL_REFRESH_TOKEN` and `GMAIL_CLIENT_SECRET` on the Worker, and *Members & access* shows which mailbox it opens. For any mailbox on the domain, set up a service account once:

1. Google Cloud console, same project as the OAuth client: **IAM & Admin → Service accounts → Create service account** (no roles needed). Open it → **Keys → Add key → JSON**, and download the file.
2. Copy the service account's **Unique ID** (a long number, on its Details tab).
3. Admin console (super admin): **Security → Access and data control → API controls → Manage Domain Wide Delegation → Add new**. Client ID: that Unique ID. OAuth scopes: `https://www.googleapis.com/auth/gmail.modify`.
4. Cloudflare: Workers & Pages → mail → Settings → Variables and secrets → **Add → Secret** `GOOGLE_SERVICE_ACCOUNT`, with the whole JSON file as the value. Deploy.
5. In Axal VC Mail, **Members & access → Shared mailboxes**: enter the mailbox and a member, then **Give access**. The Worker checks with Google that it can open the mailbox before saving.

The key can open any mailbox on the domain, so keep it only in the Worker secret, and rotate it (new key, update the secret, delete the old key) if it might have leaked.

Members and linked accounts can also be edited directly in D1 (Cloudflare dashboard → D1 → axal-mail → Console) or with `wrangler d1 execute axal-mail --remote --command "…"`:

```sql
-- Optional for @axal.vc staff (needed only to set a display name or suspend someone)
INSERT INTO members (email, name, status, created_at) VALUES ('julian@axal.vc', 'Julian Park', 'active', unixepoch() * 1000);
-- Let a personal Gmail sign in as that member
INSERT INTO linked_accounts (google_email, member_email, created_at) VALUES ('julian.park@gmail.com', 'julian@axal.vc', unixepoch() * 1000);
-- Suspend
UPDATE members SET status = 'suspended' WHERE email = 'julian@axal.vc';
```

A suspension applies to new sign-ins at once, and to open sessions within 5 minutes.

## Bug reports

*Report a bug* in the account menu files a GitHub issue (label `bug`) through the Worker. The repository is public, so the form says so, the issue never names the reporter, and email addresses are removed from everything it sends. Who filed which issue is kept in D1 (`bug_reports`) for admins. The optional technical details are the screen, path, build, browser, window size and the last few app errors. Each member can file 5 reports an hour.

To turn it on: GitHub → Settings → Developer settings → Fine-grained tokens → *Generate new token*, resource owner **AxalNetwork**, repository **mail**, permission **Issues: Read and write**. Then Cloudflare → Workers & Pages → mail → Settings → Variables and secrets → add the secret `GITHUB_TOKEN` and deploy.

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
| `POST /api/bug-report` | File a bug report as a GitHub issue |
| `GET /api/mailboxes` | Shared mailboxes this member may open |
| `/api/mailboxes/<mailbox>/(upload/)gmail/v1/users/me/…` | Gmail API for a shared mailbox, limited to what the mail client uses |
| `GET/POST /api/admin/members` · `POST/DELETE /api/admin/links` | Members, roles, status and linked accounts (admins) |
| `GET/POST/DELETE /api/admin/mailboxes` | Who opens which shared mailbox (super admins) |

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
| Mailbox switcher | Your own mailbox plus the shared mailboxes a super admin gave you (see *Shared mailboxes*) |
| Document library | Demo only |

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
  src/auth.ts             Google token verification, member and role resolution
  src/admin.ts            Members, roles and linked accounts
  src/mailboxes.ts        Shared mailbox access and the Gmail proxy
  src/delegation.ts       Domain-wide delegation tokens (service account JWT)
  src/config.ts           OAuth client ID (Worker variable or build-time fallback)
  src/assistant.ts        Claude calls and prompts
  src/notes.ts            D1 notes
  migrations/             D1 schema
wrangler.jsonc            Worker, assets, custom domain, D1 binding
public/_headers           Security headers for the static frontend
```
