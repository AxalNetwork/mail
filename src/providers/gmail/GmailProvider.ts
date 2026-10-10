import type { Capabilities, FolderCounts, ListPage, ListQuery, MailProvider } from '../types';
import type {
  Account, ActivityEvent, Category, ComposeAttachment, Contact, DraftContent, Identity, OutgoingMessage, Person,
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

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const UPLOAD = 'https://gmail.googleapis.com/upload/gmail/v1/users/me';
const PEOPLE = 'https://people.googleapis.com/v1';
const USERINFO = 'https://www.googleapis.com/oauth2/v3/userinfo';
const PAGE_SIZE = 25;
const METADATA_HEADERS = ['From', 'To', 'Subject', 'Date', 'Content-Type'];

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

/** Gmail + Google People API, called directly from the browser with the user's OAuth token. */
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

  constructor(readonly auth: GoogleAuth, orgDomainOverride = '', private notes: NotesStore = new LocalNotes()) {
    this.api = new GoogleClient(auth);
    this.orgDomain = orgDomainOverride;
    this.capabilities.sharedNotes = notes.shared;
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
    return [{ addr: a.email, access: 'Owner' }];
  }

  private async sendAs(): Promise<SendAs[]> {
    if (!this.sendAsCache) {
      const r = await this.api.request<{ sendAs?: SendAs[] }>(API + '/settings/sendAs');
      this.sendAsCache = (r.sendAs || []).filter(s => s.isPrimary || s.verificationStatus === 'accepted');
    }
    return this.sendAsCache;
  }

  async identities(): Promise<Identity[]> {
    const a = await this.account();
    let list: SendAs[] = [];
    try { list = await this.sendAs(); } catch { /* settings scope missing: primary only */ }
    if (!list.length) list = [{ sendAsEmail: a.email, displayName: a.name, isPrimary: true, isDefault: true }];
    const ids = list.map<Identity>(s => ({
      id: s.sendAsEmail,
      addr: s.sendAsEmail,
      name: s.displayName || a.name,
      kind: s.isPrimary ? 'Your mailbox' : 'Send-as address · configured in Gmail',
      short: s.isPrimary ? 'Personal' : 'Alias',
      note: s.isPrimary ? '' : 'Recipients see "' + (s.displayName || s.sendAsEmail) + '" <' + s.sendAsEmail + '>.',
      isDefault: !!s.isDefault
    }));
    // Primary first, so it is the composer's default.
    return ids.sort((x, y) => Number(y.kind === 'Your mailbox') - Number(x.kind === 'Your mailbox'));
  }

  async installSignature(html: string) {
    const list = await this.sendAs();
    const primary = list.find(s => s.isPrimary) || list[0];
    if (!primary) throw new Error('No send-as address found');
    await this.api.request(API + '/settings/sendAs/' + encodeURIComponent(primary.sendAsEmail), {
      method: 'PATCH', json: { signature: html }
    });
  }

  scheduleOptions() { return []; }
  async documents() { return []; }
  async optOuts() { return {}; }

  // ---------- labels & counts ----------

  private loadLabels(): Promise<void> {
    if (!this.labelsLoaded) {
      this.labelsLoaded = this.api.request<{ labels?: GmailLabel[] }>(API + '/labels').then(r => {
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
    const get = (id: string) => this.api.request<GmailLabel>(API + '/labels/' + id).catch(() => ({} as GmailLabel));
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
        if (!q.category || q.category === 'primary') { query.labelIds = ['INBOX']; query.q = 'category:primary'; }
        else query.labelIds = ['INBOX', q.category];
        break;
      case 'starred': query.labelIds = ['STARRED']; break;
      case 'snoozed': query.q = 'in:snoozed'; break;
      case 'sent': query.labelIds = ['SENT']; break;
      case 'scheduled': query.q = 'in:scheduled'; break;
      case 'search': query.q = q.query; break;
      case 'all': break;
    }
    const r = await this.api.request<{ threads?: { id: string }[]; nextPageToken?: string }>(API + '/threads', { query });
    const threads = await mapLimit(r.threads || [], 8, t =>
      this.api.request<GmailThread>(API + '/threads/' + t.id, { query: { format: 'metadata', metadataHeaders: METADATA_HEADERS } }));
    const now = new Date();
    return {
      threads: threads.map(t => toSummary(t, { me: a.email, labelNames: this.labelNames, now })),
      nextPageToken: r.nextPageToken
    };
  }

  private async listDrafts(pageToken?: string): Promise<ListPage> {
    const a = await this.account();
    const r = await this.api.request<{ drafts?: { id: string; message: { id: string } }[]; nextPageToken?: string }>(API + '/drafts', {
      query: { maxResults: PAGE_SIZE, pageToken }
    });
    const now = new Date();
    const threads = await mapLimit(r.drafts || [], 8, async d => {
      const m = await this.api.request<GmailMessage>(API + '/messages/' + d.message.id, { query: { format: 'metadata', metadataHeaders: METADATA_HEADERS } });
      const s = toSummary({ id: m.threadId, messages: [m] }, { me: a.email, labelNames: this.labelNames, now });
      return { ...s, id: 'draft:' + d.id, draftId: d.id, org: 'Draft', labels: ['Draft', ...s.labels] } satisfies ThreadSummary;
    });
    return { threads, nextPageToken: r.nextPageToken };
  }

  async getThread(id: string): Promise<Thread> {
    const a = await this.account();
    await this.loadLabels();
    const t = await this.api.request<GmailThread>(API + '/threads/' + id, { query: { format: 'full' } });
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
    return this.api.request<void>(API + '/threads/' + id + '/modify', { json: { addLabelIds: add, removeLabelIds: remove } });
  }

  async markRead(id: string, read: boolean) { await (read ? this.modify(id, [], ['UNREAD']) : this.modify(id, ['UNREAD'], [])); }
  async setStarred(id: string, starred: boolean) { await (starred ? this.modify(id, ['STARRED'], []) : this.modify(id, [], ['STARRED'])); }
  async archive(id: string) { await this.modify(id, [], ['INBOX']); }
  async trash(id: string) { await this.api.request(API + '/threads/' + id + '/trash', { method: 'POST' }); }
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
    const r = await this.api.request<{ data: string }>(API + '/messages/' + messageId + '/attachments/' + attachmentId);
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
    return this.api.request<T>(UPLOAD + path, {
      method, query: { uploadType: 'multipart' }, body, headers: { 'Content-Type': 'multipart/related; boundary=' + b }
    });
  }

  /** The Message-ID Gmail assigned to a message we just sent. */
  private async messageIdOf(id: string): Promise<string | undefined> {
    const m = await this.api.request<GmailMessage>(API + '/messages/' + id, { query: { format: 'metadata', metadataHeaders: ['Message-ID'] } });
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
      r = await this.api.request(API + '/drafts/send', { json: { id: msg.draftId } });
    } else {
      r = await this.upload(
        '/messages/send', 'POST', msg.reply ? { threadId: msg.reply.threadId } : {}, await this.raw(msg));
    }
    // The email is already sent; a failed note must not report the send as failed.
    await this.saveNote(msg, r.id).catch(e => console.warn('Internal note not saved', e));
    return { id: r.id, threadId: r.threadId };
  }

  async getDraft(draftId: string): Promise<DraftContent> {
    const d = await this.api.request<{ id: string; message: GmailMessage }>(API + '/drafts/' + draftId, { query: { format: 'full' } });
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
    await this.api.request(API + '/drafts/' + draftId, { method: 'DELETE' });
  }

  signOut() {
    this.auth.signOut();
  }
}

