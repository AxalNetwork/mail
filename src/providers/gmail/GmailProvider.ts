import type { Capabilities, FolderCounts, ListPage, ListQuery, MailProvider } from '../types';
import type {
  Account, ActivityEvent, ConversationSample, ConvMessage, Category, ComposeAttachment, Contact, DraftContent, Identity, OutgoingMessage, Person,
  Priority, Profile, SavedDraft, SentResult, Thread, ThreadSummary
} from '../../types';
import { GoogleAuth } from './auth';
import { GoogleClient, mapLimit } from './client';
import { header, messageBodies, toMessage, toSummary, type GmailLabel, type GmailMessage, type GmailThread } from './parse';
import { base64ToBytes, buildMime, type MimeAttachment } from '../../lib/mime';
import { orgDomainFor, parseAddressList } from '../../lib/compose';
import { fileExt, plural } from '../../lib/format';
import { textToHtml } from '../../lib/html';
import { extractBody } from '../../lib/outgoing';
import { LocalNotes, type NotesStore } from './notes';

const GMAIL = 'https://gmail.googleapis.com/';
const PEOPLE = 'https://people.googleapis.com/v1';
const USERINFO = 'https://www.googleapis.com/oauth2/v3/userinfo';
const PAGE_SIZE = 25;
const PRIMARY_QUERY = '-category:social -category:promotions -category:updates -category:forums';
const METADATA_HEADERS = ['From', 'To', 'Subject', 'Date', 'Content-Type'];
const ANALYTICS_HEADERS = ['From', 'To', 'Cc', 'Subject', 'List-Unsubscribe', 'List-Id', 'Precedence', 'Auto-Submitted'];

/** Bulk or machine-sent mail, which nobody expects an answer to. */
function isAutomated(m: GmailMessage, from: string): boolean {
  if (header(m, 'List-Unsubscribe') || header(m, 'List-Id')) return true;
  if (/^(bulk|list|junk)$/i.test(header(m, 'Precedence'))) return true;
  const auto = header(m, 'Auto-Submitted');
  if (auto && !/^no$/i.test(auto)) return true;
  return /^(no-?reply|do-?not-?reply|notifications?|mailer-daemon|postmaster)@/i.test(from);
}

interface SendAs {
  sendAsEmail: string;
  displayName?: string;
  isPrimary?: boolean;
  isDefault?: boolean;
  treatAsAlias?: boolean;
  verificationStatus?: string;
}

interface PersonResource {
  names?: { displayName?: string; givenName?: string; familyName?: string }[];
  emailAddresses?: { value?: string }[];
  organizations?: { name?: string; title?: string; location?: string }[];
  phoneNumbers?: { value?: string; type?: string }[];
  urls?: { value?: string }[];
  photos?: { url?: string; default?: boolean }[];
  locations?: { value?: string }[];
}

const PROFILE_KEY = 'axal.profile.';

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, v: unknown) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* storage full or blocked */ }
}

export interface GmailOptions {
  /** Open this shared mailbox (through the backend's delegation proxy) instead of the user's own. */
  mailbox?: string;
  /** Base URL of that proxy, e.g. https://mail.axal.vc/api/mailboxes. */
  proxyBase?: string;
  /** Shared mailboxes the user may switch to. */
  sharedMailboxes?: () => Promise<string[]>;
}

/**
 * Gmail + Google People API, called directly from the browser with the user's
 * OAuth token. A shared mailbox goes through the backend instead, which checks
 * access and calls Gmail with a delegated token; the person (profile,
 * contacts, signature details) is still the signed-in user.
 */
export class GmailProvider implements MailProvider {
  readonly kind = 'gmail' as const;
  readonly capabilities: Capabilities = {
    snooze: false, schedule: false, documents: false, mailboxSwitch: false, installSignature: true,
    // Spread bulk sends out (≈30/min) to stay well inside Gmail sending limits.
    bulkSpacingMs: 2000, demo: false, sharedNotes: false
  };
  orgDomain = '';

  private api: GoogleClient;
  private me: Account | null = null;
  private labelNames = new Map<string, string>();
  private labelsLoaded: Promise<void> | null = null;
  private sendAsCache: SendAs[] | null = null;
  private contactsWarm = false;
  private gmail: string;
  private uploads: string;
  /** The shared mailbox being shown, or undefined for the user's own. */
  readonly mailbox?: string;

  constructor(readonly auth: GoogleAuth, orgDomainOverride = '', private notes: NotesStore = new LocalNotes(), private opts: GmailOptions = {}) {
    this.api = new GoogleClient(auth);
    this.orgDomain = orgDomainOverride;
    this.capabilities.sharedNotes = notes.shared;
    const root = opts.mailbox && opts.proxyBase ? opts.proxyBase.replace(/\/$/, '') + '/' + encodeURIComponent(opts.mailbox) + '/' : GMAIL;
    this.mailbox = opts.mailbox && opts.proxyBase ? opts.mailbox : undefined;
    this.gmail = root + 'gmail/v1/users/me';
    this.uploads = root + 'upload/gmail/v1/users/me';
    // The shared mailbox's own signature is managed by its owner in Gmail.
    if (this.mailbox) this.capabilities.installSignature = false;
  }

  // ---------- account & settings ----------

  async account(): Promise<Account> {
    if (this.me) return this.me;
    const info = await this.api.request<{ email: string; name?: string; given_name?: string; family_name?: string; picture?: string }>(USERINFO);
    let person: PersonResource = {};
    try {
      person = await this.api.request<PersonResource>(PEOPLE + '/people/me', {
        query: { personFields: 'names,emailAddresses,organizations,phoneNumbers,urls,photos,locations' }
      });
    } catch { /* People API not enabled: fall back to the basic profile */ }
    const name = person.names?.[0];
    const org = person.organizations?.[0];
    const phone = person.phoneNumbers?.find(p => p.type === 'mobile') || person.phoneNumbers?.[0];
    const li = person.urls?.find(u => /linkedin\.com/i.test(u.value || ''))?.value || '';
    const photo = person.photos?.find(p => !p.default)?.url || info.picture || '';
    const base: Profile = {
      id: info.email,
      first: name?.givenName || info.given_name || info.email.split('@')[0],
      last: name?.familyName || info.family_name || '',
      title: org?.title || '',
      region: org?.location || person.locations?.[0]?.value || '',
      email: info.email,
      whatsapp: phone?.value || '',
      linkedin: li.replace(/^https?:\/\/(www\.)?/i, ''),
      photoUrl: photo || undefined,
      photo: !!photo
    };
    const profile: Profile = { ...base, ...readJson<Partial<Profile>>(PROFILE_KEY + info.email, {}) };
    this.me = {
      name: [profile.first, profile.last].filter(Boolean).join(' ') || info.name || info.email,
      email: info.email, title: profile.title, photoUrl: profile.photoUrl, profile
    };
    if (!this.orgDomain) this.orgDomain = orgDomainFor(info.email);
    this.auth.loginHint = info.email;
    return this.me;
  }

  async updateProfile(p: Profile) {
    const { id: _id, email: _e, ...rest } = p;
    writeJson(PROFILE_KEY + p.email, rest);
    this.me = null;
  }

  async profiles(): Promise<Profile[]> {
    return [(await this.account()).profile];
  }

  async mailboxes() {
    const a = await this.account();
    let shared: string[] = [];
    try { shared = (await this.opts.sharedMailboxes?.()) || []; } catch { /* backend unreachable: own mailbox only */ }
    if (this.mailbox && !shared.includes(this.mailbox)) shared = [this.mailbox, ...shared];
    this.capabilities.mailboxSwitch = shared.length > 0;
    return [{ addr: a.email, access: 'Your mailbox' }, ...shared.map(addr => ({ addr, access: 'Shared' }))];
  }

  private async sendAs(): Promise<SendAs[]> {
    if (!this.sendAsCache) {
      const r = await this.api.request<{ sendAs?: SendAs[] }>(this.gmail + '/settings/sendAs');
      this.sendAsCache = (r.sendAs || []).filter(s => s.isPrimary || s.verificationStatus === 'accepted');
    }
    return this.sendAsCache;
  }

  async identities(): Promise<Identity[]> {
    const a = await this.account();
    let list: SendAs[] = [];
    try { list = await this.sendAs(); } catch { /* settings scope missing: primary only */ }
    if (!list.length) list = [{ sendAsEmail: this.mailbox || a.email, displayName: this.mailbox ? '' : a.name, isPrimary: true, isDefault: true }];
    const ids = list.map<Identity>(s => ({
      id: s.sendAsEmail,
      addr: s.sendAsEmail,
      name: s.displayName || a.name,
      kind: s.isPrimary ? (this.mailbox ? 'Shared mailbox' : 'Your mailbox') : 'Send-as address · configured in Gmail',
      short: s.isPrimary ? 'Personal' : 'Alias',
      note: s.isPrimary ? '' : 'Recipients see "' + (s.displayName || s.sendAsEmail) + '" <' + s.sendAsEmail + '>.',
      isDefault: !!s.isDefault
    }));
    // Primary first, so it is the composer's default.
    return ids.sort((x, y) => Number(y.kind !== 'Send-as address · configured in Gmail') - Number(x.kind !== 'Send-as address · configured in Gmail'));
  }

  async installSignature(html: string) {
    const list = await this.sendAs();
    const primary = list.find(s => s.isPrimary) || list[0];
    if (!primary) throw new Error('No send-as address found');
    await this.api.request(this.gmail + '/settings/sendAs/' + encodeURIComponent(primary.sendAsEmail), {
      method: 'PATCH', json: { signature: html }
    });
  }

  scheduleOptions() { return []; }
  async documents() { return []; }
  async optOuts() { return {}; }

  // ---------- labels & counts ----------

  private loadLabels(): Promise<void> {
    if (!this.labelsLoaded) {
      this.labelsLoaded = this.api.request<{ labels?: GmailLabel[] }>(this.gmail + '/labels').then(r => {
        this.labelNames.clear();
        for (const l of r.labels || []) if (l.type === 'user') this.labelNames.set(l.id, l.name);
      }).catch(e => { this.labelsLoaded = null; throw e; });
    }
    return this.labelsLoaded;
  }

  async categories(): Promise<Category[]> {
    await this.loadLabels();
    const user = [...this.labelNames.entries()]
      .filter(([, n]) => !n.includes('/'))
      .sort((a, b) => a[1].localeCompare(b[1]))
      .slice(0, 5)
      .map(([id, label]) => ({ id, label }));
    return [{ id: 'primary', label: 'Primary' }, ...user, { id: 'CATEGORY_UPDATES', label: 'Updates' }];
  }

  async counts(): Promise<FolderCounts> {
    const get = (id: string) => this.api.request<GmailLabel>(this.gmail + '/labels/' + id).catch(() => ({} as GmailLabel));
    const [inbox, drafts] = await Promise.all([get('INBOX'), get('DRAFT')]);
    return { inbox: inbox.threadsUnread || 0, drafts: drafts.messagesTotal || 0, sent: 0, snoozed: 0, scheduled: 0 };
  }

  // ---------- threads ----------

  async listThreads(q: ListQuery): Promise<ListPage> {
    const a = await this.account();
    await this.loadLabels();
    if (q.folder === 'drafts') return this.listDrafts(q.pageToken);
    const query: Record<string, string | number | string[] | undefined> = { maxResults: PAGE_SIZE, pageToken: q.pageToken };
    switch (q.folder) {
      case 'inbox':
        // "Not in another tab" rather than category:primary, which matches
        // nothing for accounts with Gmail's inbox tabs turned off.
        if (!q.category || q.category === 'primary') { query.labelIds = ['INBOX']; query.q = PRIMARY_QUERY; }
        else query.labelIds = ['INBOX', q.category];
        break;
      case 'starred': query.labelIds = ['STARRED']; break;
      case 'snoozed': query.q = 'in:snoozed'; break;
      case 'sent': query.labelIds = ['SENT']; break;
      case 'scheduled': query.q = 'in:scheduled'; break;
      case 'search': query.q = q.query; break;
      case 'all': break;
    }
    const r = await this.api.request<{ threads?: { id: string }[]; nextPageToken?: string }>(this.gmail + '/threads', { query });
    const threads = await mapLimit(r.threads || [], 8, t =>
      this.api.request<GmailThread>(this.gmail + '/threads/' + t.id, { query: { format: 'metadata', metadataHeaders: METADATA_HEADERS } }));
    const now = new Date();
    return {
      threads: threads.map(t => toSummary(t, { me: a.email, labelNames: this.labelNames, now })),
      nextPageToken: r.nextPageToken
    };
  }

  async conversations(days: number, cap = 300): Promise<ConversationSample> {
    const a = await this.account();
    let mine = [a.email.toLowerCase(), ...(this.mailbox ? [this.mailbox] : [])];
    try { mine = [...mine, ...(await this.sendAs()).map(s => s.sendAsEmail.toLowerCase())]; } catch { /* primary only */ }
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const r = await this.api.request<{ threads?: { id: string }[]; nextPageToken?: string }>(this.gmail + '/threads', {
        query: { q: 'newer_than:' + days + 'd -in:chats -in:spam -in:trash', maxResults: Math.min(100, cap - ids.length), pageToken }
      });
      ids.push(...(r.threads || []).map(t => t.id));
      pageToken = r.nextPageToken;
    } while (pageToken && ids.length < cap);
    const threads = await mapLimit(ids, 8, id => this.api.request<GmailThread>(this.gmail + '/threads/' + id, {
      query: { format: 'metadata', metadataHeaders: ANALYTICS_HEADERS }
    }));
    return {
      truncated: !!pageToken,
      conversations: threads.map(t => ({
        id: t.id,
        subject: header(t.messages?.[0], 'Subject') || '(no subject)',
        messages: (t.messages || []).map((m): ConvMessage => {
          const sender = parseAddressList(header(m, 'From'))[0];
          const email = (sender?.email || '').toLowerCase();
          return {
            from: email,
            fromName: sender?.name || email,
            fromMe: mine.includes(email),
            to: parseAddressList([header(m, 'To'), header(m, 'Cc')].filter(Boolean).join(', ')).map(p => p.email.toLowerCase()).filter(e => e && !mine.includes(e)),
            at: Number(m.internalDate || 0),
            automated: isAutomated(m, email)
          };
        })
      }))
    };
  }

  private async listDrafts(pageToken?: string): Promise<ListPage> {
    const a = await this.account();
    const r = await this.api.request<{ drafts?: { id: string; message: { id: string } }[]; nextPageToken?: string }>(this.gmail + '/drafts', {
      query: { maxResults: PAGE_SIZE, pageToken }
    });
    const now = new Date();
    const threads = await mapLimit(r.drafts || [], 8, async d => {
      const m = await this.api.request<GmailMessage>(this.gmail + '/messages/' + d.message.id, { query: { format: 'metadata', metadataHeaders: METADATA_HEADERS } });
      const s = toSummary({ id: m.threadId, messages: [m] }, { me: a.email, labelNames: this.labelNames, now });
      return { ...s, id: 'draft:' + d.id, draftId: d.id, org: 'Draft', labels: ['Draft', ...s.labels] } satisfies ThreadSummary;
    });
    return { threads, nextPageToken: r.nextPageToken };
  }

  async getThread(id: string): Promise<Thread> {
    const a = await this.account();
    await this.loadLabels();
    const t = await this.api.request<GmailThread>(this.gmail + '/threads/' + id, { query: { format: 'full' } });
    const now = new Date();
    const s = toSummary(t, { me: a.email, labelNames: this.labelNames, now });
    const messages = (t.messages || []).filter(m => !(m.labelIds || []).includes('DRAFT')).map(m => toMessage(m, now));
    const rootKey = messages[0]?.messageIdHeader;
    const notes = rootKey ? await this.notes.list(rootKey).catch((): ActivityEvent[] => []) : [];
    const n = messages.length;
    const fromLine = s.outgoing ? 'Sent from ' + a.email : 'From ' + (s.email ? s.from.replace(/ \(\d+\)$/, '') + ' <' + s.email + '>' : s.from);
    return {
      ...s,
      noReply: /no-?reply|notifications?@/i.test(s.email),
      messages,
      activity: notes,
      linkText: fromLine + ' · ' + plural(n, 'message')
    };
  }

  private modify(id: string, add: string[], remove: string[]) {
    return this.api.request<void>(this.gmail + '/threads/' + id + '/modify', { json: { addLabelIds: add, removeLabelIds: remove } });
  }

  async markRead(id: string, read: boolean) { await (read ? this.modify(id, [], ['UNREAD']) : this.modify(id, ['UNREAD'], [])); }
  async setStarred(id: string, starred: boolean) { await (starred ? this.modify(id, ['STARRED'], []) : this.modify(id, [], ['STARRED'])); }
  async archive(id: string) { await this.modify(id, [], ['INBOX']); }
  async trash(id: string) { await this.api.request(this.gmail + '/threads/' + id + '/trash', { method: 'POST' }); }
  async snooze(): Promise<string> { throw new Error('Snooze is not available through the Gmail API.'); }

  // ---------- contacts ----------

  private toContacts(people: PersonResource[], cat: string): Contact[] {
    const out: Contact[] = [];
    for (const p of people) {
      const name = p.names?.[0]?.displayName || '';
      for (const e of p.emailAddresses || []) {
        if (!e.value) continue;
        out.push({ name: name || e.value, email: e.value, org: p.organizations?.[0]?.name || e.value.split('@')[1] || '', cat });
      }
    }
    return out;
  }

  async searchContacts(q: string): Promise<Contact[]> {
    const query = q.trim();
    try {
      if (!this.contactsWarm) {
        // The People API asks for an empty warm-up request before the first search.
        this.contactsWarm = true;
        await Promise.allSettled([
          this.api.request(PEOPLE + '/people:searchContacts', { query: { query: '', readMask: 'names,emailAddresses' } }),
          this.api.request(PEOPLE + '/otherContacts:search', { query: { query: '', readMask: 'names,emailAddresses' } })
        ]);
      }
      if (!query) {
        const r = await this.api.request<{ connections?: PersonResource[] }>(PEOPLE + '/people/me/connections', {
          query: { personFields: 'names,emailAddresses,organizations', pageSize: 10, sortOrder: 'LAST_MODIFIED_DESCENDING' }
        });
        return this.toContacts(r.connections || [], 'Contact');
      }
      const [mine, other] = await Promise.allSettled([
        this.api.request<{ results?: { person: PersonResource }[] }>(PEOPLE + '/people:searchContacts', {
          query: { query, readMask: 'names,emailAddresses,organizations', pageSize: 10 }
        }),
        this.api.request<{ results?: { person: PersonResource }[] }>(PEOPLE + '/otherContacts:search', {
          query: { query, readMask: 'names,emailAddresses', pageSize: 10 }
        })
      ]);
      const list = [
        ...(mine.status === 'fulfilled' ? this.toContacts((mine.value.results || []).map(r => r.person), 'Contact') : []),
        ...(other.status === 'fulfilled' ? this.toContacts((other.value.results || []).map(r => r.person), 'Other contact') : [])
      ];
      const seen = new Set<string>();
      return list.filter(c => !seen.has(c.email.toLowerCase()) && !!seen.add(c.email.toLowerCase()));
    } catch {
      return [];
    }
  }

  // ---------- sending & drafts ----------

  async downloadAttachment(messageId: string, attachmentId: string, mime: string): Promise<Blob> {
    const r = await this.api.request<{ data: string }>(this.gmail + '/messages/' + messageId + '/attachments/' + attachmentId);
    return new Blob([base64ToBytes(r.data) as BlobPart], { type: mime });
  }

  private async attachmentBytes(a: ComposeAttachment): Promise<MimeAttachment> {
    let blob: Blob;
    if (a.source.kind === 'file') blob = a.source.blob;
    else if (a.source.kind === 'remote') blob = await this.downloadAttachment(a.source.messageId, a.source.attachmentId, a.mime);
    else throw new Error(a.name + ' comes from the document library, which is not connected.');
    return { name: a.name, mime: a.mime || blob.type || 'application/octet-stream', data: new Uint8Array(await blob.arrayBuffer()) };
  }

  private async raw(msg: OutgoingMessage): Promise<string> {
    const attachments = await Promise.all(msg.attachments.map(a => this.attachmentBytes(a)));
    return buildMime({
      from: { name: msg.identity.name, email: msg.identity.addr, org: '' },
      to: msg.to, cc: msg.cc, bcc: msg.bcc, subject: msg.subject, html: msg.html, text: msg.text,
      attachments, priority: msg.priority, inReplyTo: msg.reply?.messageIdHeader, references: msg.reply?.references
    });
  }

  /** Media upload (multipart/related) so large attachments aren't limited by the JSON body size. */
  private upload<T>(path: string, method: 'POST' | 'PUT', metadata: unknown, raw: string): Promise<T> {
    const b = 'axal_upload_' + Math.random().toString(36).slice(2);
    const body =
      '--' + b + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(metadata) + '\r\n' +
      '--' + b + '\r\nContent-Type: message/rfc822\r\n\r\n' + raw + '\r\n--' + b + '--';
    return this.api.request<T>(this.uploads + path, {
      method, query: { uploadType: 'multipart' }, body, headers: { 'Content-Type': 'multipart/related; boundary=' + b }
    });
  }

  /** The Message-ID Gmail assigned to a message we just sent. */
  private async messageIdOf(id: string): Promise<string | undefined> {
    const m = await this.api.request<GmailMessage>(this.gmail + '/messages/' + id, { query: { format: 'metadata', metadataHeaders: ['Message-ID'] } });
    return header(m, 'Message-ID') || undefined;
  }

  private async saveNote(msg: OutgoingMessage, sentId: string) {
    const text = msg.note?.trim();
    if (!text) return;
    const key = msg.reply?.rootId || msg.reply?.messageIdHeader || (await this.messageIdOf(sentId));
    if (key) await this.notes.add(key, text, (await this.account()).name);
  }

  async saveDraft(msg: OutgoingMessage): Promise<SavedDraft> {
    const raw = await this.raw(msg);
    const message = msg.reply ? { threadId: msg.reply.threadId } : {};
    const r = msg.draftId
      ? await this.upload<{ id: string; message: { threadId: string } }>('/drafts/' + msg.draftId, 'PUT', { id: msg.draftId, message }, raw)
      : await this.upload<{ id: string; message: { threadId: string } }>('/drafts', 'POST', { message }, raw);
    return { draftId: r.id, threadId: r.message?.threadId };
  }

  async send(msg: OutgoingMessage): Promise<SentResult> {
    if (msg.schedule) throw new Error('Scheduled send is not available through the Gmail API.');
    let r: { id: string; threadId: string };
    if (msg.draftId) {
      // Update the stored draft, then send it, so Gmail doesn't keep a stale copy.
      await this.saveDraft(msg);
      r = await this.api.request(this.gmail + '/drafts/send', { json: { id: msg.draftId } });
    } else {
      r = await this.upload(
        '/messages/send', 'POST', msg.reply ? { threadId: msg.reply.threadId } : {}, await this.raw(msg));
    }
    // The email is already sent; a failed note must not report the send as failed.
    await this.saveNote(msg, r.id).catch(e => console.warn('Internal note not saved', e));
    return { id: r.id, threadId: r.threadId };
  }

  async getDraft(draftId: string): Promise<DraftContent> {
    const d = await this.api.request<{ id: string; message: GmailMessage }>(this.gmail + '/drafts/' + draftId, { query: { format: 'full' } });
    const m = d.message;
    const b = messageBodies(m);
    const attachments = await Promise.all(b.attachments.filter(a => a.attachmentId).map(async (a, i): Promise<ComposeAttachment> => ({
      id: 'r' + i, name: a.name, ext: fileExt(a.name), size: a.size, mime: a.mime, cls: 'Not classified', secure: false,
      source: { kind: 'file', blob: await this.downloadAttachment(m.id, a.attachmentId!, a.mime) }
    })));
    const inReplyTo = header(m, 'In-Reply-To');
    const refs = header(m, 'References').split(/\s+/).filter(Boolean);
    const xp = header(m, 'X-Priority');
    const priority: Priority = xp.startsWith('1') || xp.startsWith('2') ? 'High' : xp.startsWith('4') || xp.startsWith('5') ? 'Low' : 'Normal';
    const from = parseAddressList(header(m, 'From'))[0] as Person | undefined;
    return {
      draftId,
      identityAddr: from?.email,
      to: parseAddressList(header(m, 'To')),
      cc: parseAddressList(header(m, 'Cc')),
      bcc: parseAddressList(header(m, 'Bcc')),
      subject: header(m, 'Subject'),
      html: b.html ? extractBody(b.html) : textToHtml(b.text),
      attachments,
      reply: inReplyTo ? { threadId: m.threadId, messageIdHeader: inReplyTo, references: refs.filter(x => x !== inReplyTo).join(' ') || undefined, rootId: refs[0] || inReplyTo } : undefined,
      priority
    };
  }

  async deleteDraft(draftId: string) {
    await this.api.request(this.gmail + '/drafts/' + draftId, { method: 'DELETE' });
  }

  signOut() {
    this.auth.signOut();
  }
}

