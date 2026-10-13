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
| `GOOGLE_CLIENT_SECRET` | secret (or the `OAUTH_CLIENT_SECRET` GitHub secret) | OAuth client secret; exchanges *Connect sending* grants for refresh tokens |
| `TOKEN_ENCRYPTION_KEY` | secret (or the GitHub secret of the same name) | 32 bytes, base64; encrypts stored sending grants |
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

Each member's access is **Sends** or **Read only** (click the tag on their chip). Read-only members can read, label and draft, but the Worker refuses their sends.

### Shared Inboxes (team workflow)

**Workspace → Shared Inboxes** lists the shared mailboxes you can open. For each one it shows the connection (delegation or stored token, checked against Gmail), its members and their permission, your permission, and the addresses Gmail lets it send as. Conversations are read live from Gmail; nothing is copied, so there is no sync to fall behind. Open the conversations to filter them by team status and owner, claim or assign them, and open one in the mailbox view.

- **Assignment:** claim, assign, reassign, release, and filter by owner or unassigned. The assignee must have access to the mailbox. Each change names the version it was made from: if someone changed the conversation first, nothing is written and you see their change (no silent overwrite).
- **Team status:** Open, Pending, Resolved. These are Axal VC Mail states only: they never mark read, label or archive anything in Gmail, and archiving in Gmail doesn't change them.
- **In the conversation:** a bar above the messages with the status, the assignee, who else has it open or is writing a reply (heartbeats, shown for two minutes), the latest reply from a teammate, and the history of assignments, status changes and replies. Internal notes and @mentions work as everywhere else and never go into an email.
- **Sending:** the Worker checks every send as the mailbox before passing it to Gmail. The member needs send permission, and the From address must be one Gmail lets the mailbox send as (the address itself or a verified alias), or the send is refused and logged. Before a reply it also checks Gmail: if someone replied after you opened the conversation, or it is assigned to someone else, you are asked first. This is a check at send time, not a lock: two people can still write replies at once, but the second is warned before it goes out. The confirmation names which address the message went from.
- **Audit:** assignments, status changes, replies (with the send-as address) and refused sends are logged with who and when, never message content (D1 `shared_activity`; migration `0010_shared_inboxes.sql`).

Limitations: filters apply to the inbox page loaded on screen (more with *Load more*). Tasks will link once Tasks & Approvals (issue #2) exists. Production needs a service account key or refresh token on the Worker before any of this can be used.

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

## Internal

Every conversation has an **Internal** panel under its messages: notes (context such as "Potential LP, interested in AI infrastructure") and comments, visible to Axal VC members only and never part of an email. Type `@` to mention a teammate; mentions show up, unread first, on **Workspace → Internal** (with a count in the sidebar), next to the team's recent discussion. Clicking one opens the conversation in your own mailbox (found by its Message-ID). Authors edit their notes; authors or admins delete them (the text is wiped, the history keeps who did it). **History** lists who added, edited, deleted or mentioned, without note text.

Notes are keyed by the conversation's first `Message-ID`, so teammates' copies of the same thread share one discussion. The internal note in the composer is saved here on send and never included in the message.

## Contacts & Relationships

**Workspace → Contacts & Relationships** keeps the people and organizations the team chose to track, linked to email without copying it.

- **People:** name, any number of email addresses (an address belongs to one record), role, organization, website and LinkedIn URL (only when someone types them), tags, relationship owner and notes. Search, filter by tag or owner, archive and restore, and export what is listed to CSV (notes are left out). Records with the same name are flagged as possible duplicates and can be merged after a confirmation: addresses, tags, notes and recorded events move to the record you keep, and the other one is archived.
- **Organizations:** name, email domain, website, type (portfolio company, prospect, LP / investor, co-investor, service provider, corporate, other), tags, owner and notes, with their people. "Atlas Systems, Inc." and "atlas systems" are the same name, and a second organization with the same name or domain is refused, with a link to the existing one.
- **Email history:** for each record, the conversations in your own mailbox over the last 90 days, read from the same metadata Analytics uses (who wrote to whom and when; never content). The indicators are plain counts: last interaction, messages in 30 days, conversations in 90 days, waiting on you, follow-ups due, recorded introductions, and **stale**, a rule you set (default 60 days without email) or turn off. There is no relationship score.
- **Recorded events:** introductions, meetings and notes someone records by hand, optionally linked to an email. Nothing is inferred; mutual connections are never guessed.
- **AI (needs `ANTHROPIC_API_KEY`):** *Summarize relationship* and *Prepare meeting briefing* read the record and your latest 6 conversations with the person. Facts, open questions and prior commitments must cite a conversation or the record (the Worker drops any that don't), and the model's own inferences are listed separately. *Draft follow-up* opens a reply you review and send yourself.
- **Suggestions:** people you have exchanged email with both ways in the last 90 days, outside the firm, not bulk mail and not already a record, with the conversation they came from. Nothing is created until you review the form; you can also add the address to an existing record, or dismiss it (remembered on this device). No outside lookup or enrichment is made.

A record is **team** (every member sees and edits it) or **private** (only its creator and relationship owner). Only those two can change the owner or visibility. The Worker filters every read and write on this, so a private record answers 404 to anyone else, and a team and a private record can't be merged. Records live in D1 (migration `0009_contacts.sql`); without the backend the page says so.

Limitations: email history covers the signed-in member's own mailbox and the last 90 days (up to 500 conversations), not teammates' mailboxes or shared inboxes. Internal notes stay on their conversations rather than being copied to records, and tasks will be linked once Tasks & Approvals (issue #2) exists.

## Analytics and AI Automations

**Analytics** (Workspace → Analytics) has three tabs, a period (7, 30 or 90 days, or a custom range up to 180 days back) and, when you can open shared mailboxes, a mailbox filter (this mailbox, one shared mailbox, or all of them).

- **Communication** reads the metadata of conversations in the period (senders, recipients, times, Message-ID and bulk-mail headers; never bodies) straight from Gmail into the browser, up to 300 conversations (500 beyond 30 days), and computes everything there. Nothing is stored or sent anywhere. It shows sent and received per day and per week, active conversations per week, *time to first response* (in conversations someone else started: their first message to your first answer) apart from *time between replies* (each incoming message to your next one), with their distributions, their response time, message and contact reply rates, unanswered conversations (a person wrote last; not the same as a missed commitment), sending hours, top contacts and, for all mailboxes, volume per mailbox. Days and weeks are in the browser's time zone, weeks start on Monday, a message seen twice (same Message-ID, e.g. in two mailboxes) counts once, and messages without a date are left out. *Export CSV* saves the figures (counts and durations, no addresses or subjects). Definitions are under *How these are measured*. A **Deliverability** panel checks the domain's MX, SPF, DKIM (Google selector) and DMARC records through the Worker (`GET /api/analytics/deliverability`, organization domains only).
- **Outreach** summarizes investor outreach sequences from the tables the sequence runner already keeps (`GET /api/analytics/outreach`; members see their own, admins everyone's): campaigns created, awaiting approval, messages **accepted by Gmail**, failed, unconfirmed (a send that never reported back), and recipients who replied, sent a bounce notice or opted out. Gmail confirms acceptance, not delivery, so **delivery is reported as unknown**. Bulk email runs are logged **in this browser only** (`localStorage`: time, subject template, sending address, counts and Gmail thread ids, no text); their replies and bounce notices are read from the same conversation metadata. Opens and clicks aren't tracked: that needs pixels or tracked links, which are unreliable and need consent.
- **Team** covers a shared mailbox you can open (`GET /api/shared/<mailbox>/summary`, members of that mailbox only): conversations by team status, unassigned and not yet triaged, the mailbox's time to first response, and per member what they hold now plus replies and claims in the period. Members are listed alphabetically; it is not a ranking or a performance score. Outstanding tasks and approvals will appear once Tasks & Approvals exists.

New data collection for this: none on the server (outreach and team figures come from existing D1 tables, with the same access rules as their own pages); the bulk email log stays on the device and can be cleared from the Outreach tab.

**AI Automations** turns the same data into work to approve. Nothing is ever sent automatically, and an email can never authorize an action by itself.

- **Daily briefing**: counts for the last 24 hours, plus (with the assistant) a written summary whose priorities and dates each link to the conversation they come from. The Worker drops any item that does not cite a conversation it was given.
- **Intelligent inbox manager**: for the latest 20 inbox conversations, a suggested category (Investor, Founder, Investment opportunity, Portfolio company, Partnership, Event, Administrative, Newsletter, Other), priority, urgency, whether a reply is needed, confidence, a one-line explanation and action items. It reads sender and preview only. A label (`AI/<Category>`, created on first use) is added only after you confirm it, one conversation at a time.
- **Follow-up agent** (you wrote last, 3+ days ago) and **reply assistant** (someone is waiting on you): each row says why it is there and offers *Draft*, which opens the composer with an assistant draft, and *Dismiss*. A dismissal is kept per member for 120 days and keyed to the latest message, so the row comes back only if the conversation moves on.
- A status table shows what is operational, partial, needs setup, blocked or planned. Email-to-CRM is blocked on Contacts (issue #5); meeting scheduling needs Google Calendar access; the support agent needs a shared support inbox (issue #6) and an approved answer base; document processing needs Documents (issue #7).

The inbox manager and the written briefing need `ANTHROPIC_API_KEY`; without it they say so and everything else keeps working. Dismissals are stored in D1 (migration `0008_automations.sql`), or in the browser when there is no backend.

## Outreach sequences

AI Automations → **Investor outreach sequences**: a first email plus up to five timed follow-ups ("if no reply after N days"), with merge fields, sent to up to 200 external recipients from the owner's Gmail **by the Worker**, so no browser needs to stay open.

- **Approval:** a sequence starts as a draft. An admin (or a super admin, for their own) approves the exact version; any edit makes a new version that needs approval again, and the cron only sends for `approved_version = version`.
- **Sending:** each owner clicks **Connect sending** once. Google asks for `gmail.send` and `gmail.readonly`, and the Worker exchanges the code (client secret) for a refresh token stored AES-GCM-encrypted in D1 (`sender_credentials`). **Disconnect** revokes it. With domain-wide delegation (`GOOGLE_SERVICE_ACCOUNT`) no grant is needed.
- **Schedule:** a Cron Trigger every 10 minutes sends at most 20 due steps per run. Follow-ups are replies in the same thread (`In-Reply-To` / `References`), or a new subject if the step has one.
- **Stop rules,** checked against the live thread before each send: any reply, a bounce, or "unsubscribe / remove me" ends that recipient's sequence (the last adds them to `opt_outs`, honored by every sequence). Owners can also stop or opt out a person. Every email ends with an unsubscribe line.
- **Exactly once:** each (recipient, step) is claimed in `sequence_sends` before sending. Gmail 429/5xx releases the claim for a retry (3 tries); a send whose outcome is unknown is never repeated and is flagged "check Sent mail".

To turn it on:
1. Google Cloud → the OAuth client: add `https://www.googleapis.com/auth/gmail.send` and `…/gmail.readonly` to the consent screen's scopes, and copy the **client secret**.
2. GitHub → Settings → Secrets → Actions: `OAUTH_CLIENT_SECRET` (that secret) and `TOKEN_ENCRYPTION_KEY` (32 random bytes, base64: `openssl rand -base64 32`). The deploy copies them to the Worker as `GOOGLE_CLIENT_SECRET` and `TOKEN_ENCRYPTION_KEY`. Keep the key: losing it means everyone connects sending again.
3. Apply migration `0006_sequences.sql` (`npm run db:migrate`).

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
| `GET /api/notes?key=<Message-ID>` · `POST /api/notes` | Internal notes and comments for a conversation (`kind`, `subject`, `mentions`). Keyed by the first message's `Message-ID`, the same in every teammate's mailbox (Gmail thread IDs are not). |
| `PATCH/DELETE /api/notes/:id` · `GET /api/notes/activity?key=` | Edit (author) or delete (author or admin); the conversation's activity history |
| `GET /api/internal` · `POST /api/internal/read` · `GET /api/internal/members` | Your mentions and the team's recent discussion; mark mentions read; who can be mentioned |
| `POST /api/assistant/insight` | Summary, extracted points, suggested reply |
| `POST /api/assistant/draft` | Draft from an instruction and/or the thread |
| `POST /api/assistant/rewrite` | `shorter`, `formal`, `warmer`, `clarity`, `translate` (French) |
| `POST /api/assistant/persona` | Bulk email subject and body for one persona, with merge tokens |
| `POST /api/assistant/classify` | Inbox manager suggestions for up to 25 conversations (metadata and preview); unknown ids are dropped |
| `POST /api/assistant/briefing` | Daily briefing: summary, priorities and explicit commitments, each citing a given conversation |
| `GET/POST /api/contacts` · `GET/PATCH /api/contacts/:id` | Contacts you may see (`q`, `tag`, `org`, `owner`, `archived`); create; read with recorded events and possible duplicates; edit |
| `POST /api/contacts/:id/archive\|merge` · `GET /api/contacts/duplicates` | Archive or restore; merge another record into this one; groups of same-name records |
| `POST /api/contacts/:id/events` · `DELETE …/events/:eid` | Record an introduction, meeting or note; remove your own |
| `GET/POST /api/organizations` · `GET/PATCH /api/organizations/:id` | Organizations (`q`, `type`, `archived`), create, read with people, edit or archive |
| `POST /api/assistant/relationship` | Relationship summary or meeting briefing (`mode`), facts cited to conversations or the record |
| `GET/POST/DELETE /api/automations/dismissed` | Dismissed follow-up, reply and inbox suggestions (`{ kind, key }`) |
| `POST /api/bug-report` | File a bug report as a GitHub issue |
| `GET/POST/DELETE /api/sequences/sender` | Sending grant status, connect (authorization code), disconnect |
| `GET/POST /api/sequences` · `GET/PUT /api/sequences/:id` | Outreach sequences: list, create, read, edit (new version) |
| `POST /api/sequences/:id/approve\|start\|pause\|stop` · `…/recipients/:rid/stop` | Approve a version (admins), run controls, stop or opt out one person |
| `GET /api/analytics/deliverability` | MX, SPF, DKIM and DMARC checks for the organization domain |
| `GET /api/analytics/outreach?from=&to=` | Sequence figures: created, awaiting approval, accepted by Gmail, failed, unconfirmed, replied, bounce notices, opt-outs (delivery: unknown) |
| `GET /api/shared/<mailbox>/summary?from=&to=` | Shared mailbox workload by status and member (members of the mailbox only) |
| `GET /api/mailboxes` | Shared mailboxes this member may open |
| `GET /api/shared` | Shared mailboxes with connection, members, permissions and send-as addresses |
| `GET /api/shared/<mailbox>/threads?ids=…` · `?status=&assignee=` | Team status, assignee and presence for conversations |
| `GET/PATCH /api/shared/<mailbox>/threads/:id` · `…/activity` · `POST …/presence` | One conversation with its history; assign or set status (`expectedVersion`, 409 on conflict); viewing/replying heartbeat |
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
                          composer/, bulk/, admin/, analytics/, automations/, internal/, contacts/, shared/
  styles/app.css          Design tokens and component styles
worker/                   Backend (Cloudflare Worker)
  src/index.ts            Router; non-/api paths are served from dist/ by Cloudflare
  src/auth.ts             Google token verification, member and role resolution
  src/admin.ts            Members, roles and linked accounts
  src/mailboxes.ts        Shared mailbox access and the Gmail proxy
  src/delegation.ts       Domain-wide delegation tokens (service account JWT)
  src/senders.ts          Per-member offline sending grants (encrypted refresh tokens)
  src/sequences.ts        Outreach sequences API and the cron runner
  src/config.ts           OAuth client ID (Worker variable or build-time fallback)
  src/assistant.ts        Claude calls and prompts
  src/notes.ts            Internal notes, comments, mentions and activity (D1)
  src/contacts.ts         Contacts, organizations, merges and recorded events, with visibility checks (D1)
  src/shared.ts           Shared inbox assignment, status, presence, audit and send checks (D1)
  migrations/             D1 schema
wrangler.jsonc            Worker, assets, custom domain, D1 binding
public/_headers           Security headers for the static frontend
```
