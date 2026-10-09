# Axal VC Mail — frontend

The web client for Axal VC Mail, built from the Claude Design prototype. It covers the mailbox, thread reader, AI assistant panel, composer (send-as identities, send review, templates, internal notes), bulk email (CSV → personas → per-person preview → send), and the standard email signature.

It runs in two modes:

| Mode | When | Data |
| --- | --- | --- |
| **Gmail** | `VITE_GOOGLE_CLIENT_ID` is set | Your real Gmail / Google Workspace mailbox, through the Gmail and People APIs, called directly from the browser with your OAuth token. |
| **Demo** | No client ID, or "Explore the demo" on the sign-in screen | Fictional sample data held in memory. Sending records the message locally; nothing is delivered. |

## Run it

```bash
npm install
cp .env.example .env.local   # add your Google OAuth client ID (optional)
npm run dev                  # http://localhost:5173
```

| Script | |
| --- | --- |
| `npm run dev` | Dev server |
| `npm run build` | Typecheck, then production build into `dist/` |
| `npm test` | Unit tests (Vitest + jsdom) |
| `npm run typecheck` | TypeScript only |

`dist/` is a static site; host it anywhere that serves HTTPS.

## Connect it to Gmail

1. **Create a Google Cloud project** at <https://console.cloud.google.com/>.
2. **Enable the APIs** (APIs & Services → Library): *Gmail API* and *People API*.
3. **Configure the OAuth consent screen** (APIs & Services → OAuth consent screen).
   - For a Google Workspace domain, pick **Internal**. Only your organization's users can sign in, and Google's app verification isn't required.
   - With **External** (consumer Gmail accounts), `gmail.modify` is a restricted scope. You can add test users while the app is in testing, but publishing it needs Google's verification and security assessment.
   - Add the scopes listed below.
4. **Create an OAuth client ID** (APIs & Services → Credentials → Create credentials → OAuth client ID → *Web application*).
   - Authorized JavaScript origins: `http://localhost:5173` plus your production origin, e.g. `https://mail.axal.vc`.
   - No redirect URI is needed; the app uses the Google Identity Services token popup.
5. Put the client ID in `.env.local`:

   ```
   VITE_GOOGLE_CLIENT_ID=1234567890-abc.apps.googleusercontent.com
   VITE_ORG_DOMAIN=axal.vc        # optional; defaults to the signed-in account's domain
   VITE_ASSISTANT_URL=            # optional; see "Assistant API"
   ```

6. `npm run dev`, then **Sign in with Google**.

### Scopes

| Scope | Used for |
| --- | --- |
| `openid`, `email`, `profile` | Who is signed in; name and photo for the signature |
| `gmail.modify` | Read threads, mark read, star, archive, trash, send, and create/update/send drafts |
| `gmail.settings.basic` | List send-as addresses; install the standard signature in Gmail |
| `contacts.readonly`, `contacts.other.readonly` | Recipient autocomplete from your contacts and "other contacts" |

The access token is kept in `sessionStorage` (it lasts about an hour and is refreshed silently). Only the last signed-in address is kept in `localStorage`, to offer "Continue as …".

### How the design maps to Gmail

| Feature | Gmail mode |
| --- | --- |
| Inbox tabs | *Primary* (`category:primary`), your top-level Gmail labels, and *Updates* |
| Starred / Sent / Drafts / All Mail | Gmail labels and drafts. Clicking a draft reopens it in the composer. |
| Snoozed / Scheduled folders | Listed with `in:snoozed` / `in:scheduled`. **Snoozing and scheduling a send are not available**: the Gmail API has no endpoints for them, so those controls are disabled. |
| Search | Gmail search syntax (`from:maya has:attachment`) |
| Reply / Reply all / Forward | Threaded with `threadId`, `In-Reply-To` and `References`. Reply all drops your own addresses. Forward can re-attach the original files. |
| From / send-as | Your Gmail send-as addresses (primary plus verified aliases) |
| Drafts | Autosaved to Gmail as you type. Sending a draft updates it, then sends it, so no stale copy is left behind. |
| Attachments | Uploaded as MIME parts through Gmail's multipart upload endpoint. Gmail's 25 MB message limit applies. |
| Send review | The same checks as the prototype: external recipients plus confidential files, fund-term wording, send-as, and more than 10 recipients |
| Priority | `X-Priority` / `Importance` headers |
| Internal notes | Saved with the thread **on this device** (Gmail can't store them), and never included in the email |
| Bulk email | One message per recipient, about 30 per minute. Investor and LP personas are **saved to Drafts** for partner approval instead of being sent. Gmail's daily sending limits apply. |
| Signature | Built from your Google profile. Missing fields (WhatsApp, LinkedIn, region) can be filled in under *Administration* and stored on this device. **Install in Gmail** writes the same HTML to your Gmail signature setting. |
| HTML mail | Rendered in a sandboxed iframe (no scripts, links open in a new tab). Remote images stay blocked until you choose *Show images*. |
| Mailbox switcher, document library, delegated mailboxes | Demo only. Delegated access needs Workspace domain-wide delegation through a backend. |

## Assistant API

In demo mode the assistant uses canned summaries. In Gmail mode, summaries, drafting from context and rewrites need a backend that holds the model. Set `VITE_ASSISTANT_URL` and implement:

| Endpoint | Request body | Response |
| --- | --- | --- |
| `POST /insight` | `{ thread }` | `{ summary, points: [{ kind, text, src, tone }], draft? }` or `null` |
| `POST /draft` | `{ thread, instruction, recipientFirstName }` | `{ html?, note: { title, text } }` |
| `POST /rewrite` | `{ html, mode, thread }`; `mode` is `shorter`, `formal`, `warmer`, `clarity` or `translate` | `{ html?, note }` |
| `POST /persona` | `{ persona, tone, brief }` | `{ subject, body }` (body may use `{first_name}`, `{company\|fallback}`, `{opening}`) |

`thread` contains text bodies only (no raw HTML). The user's Google access token is sent as `Authorization: Bearer …`, so the backend can check who is asking. Without a backend, drafting from an instruction and bulk persona messages fall back to templates, and rewrites are disabled.

## Code map

```
src/
  App.tsx                 Sign-in screen, demo vs Gmail session
  MailApp.tsx             App shell: folders, list, reader, assistant, composer wiring
  config.ts               VITE_* settings
  types.ts                Shared domain types
  providers/
    types.ts              MailProvider interface + capability flags
    demo/                 In-memory provider and sample data
    gmail/
      auth.ts             Google Identity Services token client
      client.ts           Authenticated fetch (401 refresh, 429/5xx backoff)
      parse.ts            Gmail message/thread → app types
      GmailProvider.ts    Gmail + People API implementation
  assistant/              Demo, offline and HTTP assistant implementations
  lib/                    Pure logic: CSV, bulk merge, send checks, MIME builder, signature HTML
  components/             Header, Sidebar, ThreadList, ThreadReader, AssistantPanel,
                          composer/, bulk/, admin/
  styles/app.css          Design tokens and component styles
```

A different mail backend (Microsoft Graph, a server-side API) is a new `MailProvider` implementation; the UI only reads `provider.capabilities` to decide what to show.
