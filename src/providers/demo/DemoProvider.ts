import type { Capabilities, FolderCounts, ListPage, ListQuery, MailProvider } from '../types';
import type { Account, Contact, ConversationSample, ConvMessage, DraftContent, Message, OutgoingMessage, Profile, SavedDraft, SentResult, Thread } from '../../types';
import { clockTime } from '../../lib/format';
import { htmlToText } from '../../lib/html';
import { extractBody } from '../../lib/outgoing';
import { profileName } from '../../lib/signature';
import {
  CATEGORIES, CONTACTS, DOCS, IDENTITIES, MAILBOXES, OPT_OUTS, ORG_DOMAIN, PROFILES, SCHEDULES, THREADS, type DemoThread
} from './data';

interface StoredDraft extends DraftContent {
  identityAddr: string;
  threadId: string;
}

const clone = <T,>(x: T): T => structuredClone(x);

/** Everything happens in memory. Sending records the message locally; nothing is delivered. */
export class DemoProvider implements MailProvider {
  readonly kind = 'demo' as const;
  readonly orgDomain = ORG_DOMAIN;
  readonly capabilities: Capabilities = {
    snooze: true, schedule: true, documents: true, mailboxSwitch: true, installSignature: false, bulkSpacingMs: 0, demo: true, sharedNotes: true
  };

  private threads: DemoThread[] = clone(THREADS);
  private outbox: DemoThread[] = [];
  private drafts = new Map<string, StoredDraft>();
  private profilesList: Profile[] = clone(PROFILES);
  private seq = 1;

  async account(): Promise<Account> {
    const p = this.profilesList[0];
    return { name: profileName(p), email: p.email, title: p.title, profile: p };
  }
  async mailboxes() { return MAILBOXES; }
  async categories() { return CATEGORIES.map(c => ({ id: c, label: c })); }
  async identities() { return IDENTITIES; }
  scheduleOptions() { return SCHEDULES; }
  async documents() { return DOCS; }
  async optOuts() { return OPT_OUTS; }
  async profiles() { return this.profilesList; }
  async installSignature() { /* not available in demo */ }

  async counts(): Promise<FolderCounts> {
    const open = this.open();
    return {
      inbox: open.filter(t => t.unread && t.cat !== 'Notifications').length,
      snoozed: this.threads.filter(t => t.snoozed).length,
      sent: this.outbox.filter(o => o.folder === 'sent').length,
      drafts: this.outbox.filter(o => o.folder === 'draft').length,
      scheduled: this.outbox.filter(o => o.folder === 'scheduled').length
    };
  }

  private open() { return this.threads.filter(t => !t.archived && !t.snoozed); }

  /** Fictional, but stable: a seeded mix of conversations over the last 90 days. */
  async conversations(days: number): Promise<ConversationSample> {
    const me = (await this.account()).email;
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    const now = Date.now();
    const H = 3_600_000;
    const people = CONTACTS.filter(c => c.email && c.email !== me);
    const conversations = Array.from({ length: 140 }, (_, i) => {
      const p = people[i % people.length];
      const automated = i % 7 === 6;
      let at = now - rnd() * 90 * 24 * H;
      // Office hours, mostly.
      const d = new Date(at); d.setHours(8 + Math.floor(rnd() * 10), Math.floor(rnd() * 60)); at = Math.min(d.getTime(), now - H);
      const messages: ConvMessage[] = [];
      let fromMe = !automated && rnd() < 0.45;
      const turns = automated ? 1 : 1 + Math.floor(rnd() * 4);
      for (let k = 0; k < turns && at < now; k++) {
        messages.push(fromMe
          ? { from: me, fromName: 'You', fromMe: true, to: [p.email], at, automated: false }
          : { from: automated ? 'notifications@carta.example' : p.email, fromName: automated ? 'Carta' : p.name, fromMe: false, to: [], at, automated });
        fromMe = !fromMe;
        at += (0.3 + rnd() * (rnd() < 0.2 ? 90 : 14)) * H;
      }
      const t = THREADS[i % THREADS.length];
      return { id: t.id, subject: t.subject, messages };
    }).filter(c => c.messages.some(m => m.at >= now - days * 24 * H));
    return { conversations, truncated: false };
  }

  async listThreads(q: ListQuery): Promise<ListPage> {
    const cat = q.category || 'Primary';
    const inCat = (t: DemoThread) => (cat === 'Primary' ? t.cat !== 'Notifications' : t.cat === cat);
    const sent = this.outbox.filter(o => o.folder === 'sent');
    let list: DemoThread[];
    switch (q.folder) {
      case 'inbox': list = this.open().filter(inCat); break;
      case 'starred': list = this.threads.filter(t => t.starred); break;
      case 'snoozed': list = this.threads.filter(t => t.snoozed); break;
      case 'sent': list = sent; break;
      case 'drafts': list = this.outbox.filter(o => o.folder === 'draft'); break;
      case 'scheduled': list = this.outbox.filter(o => o.folder === 'scheduled'); break;
      case 'all': list = [...this.threads, ...sent]; break;
      case 'search': {
        const needle = (q.query || '').toLowerCase();
        list = [...this.threads, ...this.outbox].filter(t =>
          [t.from, t.email, t.org, t.subject, t.snippet, ...t.messages.map(m => m.text)].join(' ').toLowerCase().includes(needle));
        break;
      }
    }
    return { threads: list.map(({ messages: _m, activity: _a, ...s }) => clone(s)) };
  }

  private find(id: string): DemoThread {
    const t = this.threads.find(x => x.id === id) || this.outbox.find(x => x.id === id);
    if (!t) throw new Error('Conversation not found');
    return t;
  }

  async getThread(id: string): Promise<Thread> {
    const t = clone(this.find(id));
    t.linkText = t.folder ? 'Sent from ' + t.email : 'Linked to ' + t.from + ' · ' + t.org + ' · Relationship owner: ' + t.owner;
    return t;
  }

  async markRead(id: string, read: boolean) { this.find(id).unread = !read; }
  async setStarred(id: string, starred: boolean) { this.find(id).starred = starred; }
  async archive(id: string) { this.find(id).archived = true; }
  async applyLabel(id: string, name: string) { const t = this.find(id); if (!t.labels.includes(name)) t.labels.push(name); }
  async trash(id: string) { this.find(id).archived = true; }
  async snooze(id: string) { this.find(id).snoozed = true; return 'Monday 09:00'; }

  async searchContacts(q: string): Promise<Contact[]> {
    const n = q.trim().toLowerCase();
    return CONTACTS.filter(p => !n || (p.name + ' ' + p.email + ' ' + p.org).toLowerCase().includes(n));
  }

  async downloadAttachment(_m: string, _a: string, mime: string): Promise<Blob> {
    return new Blob(['Sample attachment from the Axal VC Mail demo.'], { type: mime });
  }

  private senderName(msg: OutgoingMessage): string {
    const me = profileName(this.profilesList[0]);
    return msg.identity.kind.startsWith('Delegated') ? me + ' on behalf of ' + msg.identity.name : msg.identity.name;
  }

  private outboxItem(msg: OutgoingMessage, id: string, folder: DemoThread['folder']): DemoThread {
    const all = [...msg.to, ...msg.cc, ...msg.bcc];
    const text = msg.text || htmlToText(msg.html);
    const bodyText = htmlToText(extractBody(msg.html));
    const now = clockTime();
    const message: Message = {
      id: id + '-m', from: this.senderName(msg), email: msg.identity.addr, to: all.map(p => p.name).join('; ') || '—',
      time: 'Today ' + now, date: Date.now(), text, html: msg.html, demo: folder !== 'draft',
      attachments: msg.attachments.map(a => ({ name: a.name, ext: a.ext, size: a.size, mime: a.mime }))
    };
    return {
      id, folder, cat: 'Primary', owner: msg.identity.name, outgoing: true,
      from: all.length ? all.map(p => p.name).join(', ') : '(no recipients)', org: folder === 'draft' ? 'Draft' : msg.identity.addr,
      email: msg.identity.addr, time: now, date: Date.now(), subject: msg.subject || '(no subject)', snippet: bodyText.replace(/\s+/g, ' ').slice(0, 90) || '(empty)',
      labels: [folder === 'draft' ? 'Draft' : folder === 'scheduled' ? 'Scheduled · ' + msg.schedule!.when : 'Sent'],
      attachCount: msg.attachments.length, unread: false, starred: false,
      messages: [message], activity: msg.note ? [{ text: 'Internal note: ' + msg.note, time: now }] : [], linkText: ''
    };
  }

  async saveDraft(msg: OutgoingMessage): Promise<SavedDraft> {
    const draftId = msg.draftId || 'd' + this.seq++;
    const item = { ...this.outboxItem(msg, 'o' + draftId, 'draft'), draftId };
    this.outbox = [item, ...this.outbox.filter(o => o.id !== item.id)];
    this.drafts.set(draftId, {
      draftId, threadId: item.id, identityAddr: msg.identity.addr, to: msg.to, cc: msg.cc, bcc: msg.bcc, subject: msg.subject,
      html: extractBody(msg.html), attachments: msg.attachments, reply: msg.reply, note: msg.note, priority: msg.priority
    });
    return { draftId, threadId: item.id };
  }

  async getDraft(draftId: string): Promise<DraftContent> {
    const d = this.drafts.get(draftId);
    if (!d) throw new Error('Draft not found');
    return d;
  }

  async deleteDraft(draftId: string) {
    this.drafts.delete(draftId);
    this.outbox = this.outbox.filter(o => o.draftId !== draftId);
  }

  async send(msg: OutgoingMessage): Promise<SentResult> {
    if (msg.draftId) await this.deleteDraft(msg.draftId);
    const folder = msg.schedule ? 'scheduled' : 'sent';
    const id = 'o' + this.seq++;
    const item = this.outboxItem(msg, id, folder);
    this.outbox = [item, ...this.outbox];
    if (msg.reply && folder === 'sent') {
      const t = this.threads.find(x => x.id === msg.reply!.threadId);
      if (t) {
        t.messages = [...t.messages, item.messages[0]];
        t.activity = [...t.activity, ...item.activity, { text: 'Reply recorded in demo mode · not delivered', time: clockTime() }];
      }
    }
    return { id, threadId: id, scheduled: folder === 'scheduled' };
  }

  async updateProfile(p: Profile) {
    this.profilesList = this.profilesList.map(x => (x.id === p.id ? p : x));
  }
}
