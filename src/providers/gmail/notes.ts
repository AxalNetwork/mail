/**
 * Internal notes and comments on a conversation, keyed by the RFC 5322
 * Message-ID of its first message so every team member's mailbox resolves to
 * the same discussion. They never go into an email.
 */

export type NoteKind = 'note' | 'comment';

export interface InternalNote {
  id: number;
  key: string;
  kind: NoteKind;
  text: string;
  author: string;
  authorEmail: string;
  subject: string;
  createdAt: number;
  updatedAt: number | null;
  mentions: { email: string; name: string }[];
  mine: boolean;
  canEdit: boolean;
  canDelete: boolean;
}

export interface NoteActivity { action: string; actor: string; target: string | null; at: number }
export interface Mentionable { email: string; name: string }
export interface InternalInbox { mentions: (InternalNote & { read: boolean })[]; recent: InternalNote[]; unread: number }

export interface AddNote { kind?: NoteKind; subject?: string; mentions?: string[] }

export interface NotesStore {
  /** Notes are visible to the whole team (backend), not just this device. */
  readonly shared: boolean;
  list(key: string): Promise<InternalNote[]>;
  add(key: string, text: string, authorName: string, o?: AddNote): Promise<InternalNote>;
  edit(id: number, text: string, mentions?: string[]): Promise<InternalNote>;
  remove(id: number): Promise<void>;
  activity(key: string): Promise<NoteActivity[]>;
  /** Team-wide features (backend only). */
  members?(): Promise<Mentionable[]>;
  inbox?(): Promise<InternalInbox>;
  markRead?(ids?: number[]): Promise<void>;
}

const LOCAL_KEY = 'axal.notes.v2';

function readLocal(): InternalNote[] {
  try { return JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]'); } catch { return []; }
}
function writeLocal(all: InternalNote[]) {
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify(all)); } catch { /* storage full or blocked */ }
}

/** Fallback when no backend is deployed: notes stay in this browser. */
export class LocalNotes implements NotesStore {
  readonly shared = false;
  async list(key: string) { return readLocal().filter(n => n.key === key); }
  async add(key: string, text: string, authorName: string, o: AddNote = {}) {
    const all = readLocal();
    const n: InternalNote = {
      id: Math.max(0, ...all.map(x => x.id)) + 1, key, kind: o.kind || 'note', text, author: authorName || 'You', authorEmail: '',
      subject: o.subject || '', createdAt: Date.now(), updatedAt: null, mentions: [], mine: true, canEdit: true, canDelete: true
    };
    writeLocal([...all, n]);
    return n;
  }
  async edit(id: number, text: string) {
    const all = readLocal().map(n => (n.id === id ? { ...n, text, updatedAt: Date.now() } : n));
    writeLocal(all);
    return all.find(n => n.id === id)!;
  }
  async remove(id: number) { writeLocal(readLocal().filter(n => n.id !== id)); }
  async activity() { return []; }
}

/** Notes stored by the Axal VC Mail backend (Cloudflare D1), shared with the team. */
export class RemoteNotes implements NotesStore {
  readonly shared = true;
  /** `base` is the notes endpoint (/api/notes); the Internal endpoints live next to it. */
  constructor(private base: string, private token: () => Promise<string>) {}

  private async call<T>(url: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(url, {
      ...init,
      headers: { Authorization: 'Bearer ' + (await this.token()), ...(init.body ? { 'Content-Type': 'application/json' } : {}) }
    });
    if (!res.ok) {
      const j = await res.json().catch(() => null) as { error?: string } | null;
      throw new Error(j?.error || 'Notes request failed (' + res.status + ')');
    }
    return res.json() as Promise<T>;
  }
  private get internal() { return this.base.replace(/\/notes$/, '/internal'); }

  async list(key: string) { return (await this.call<{ notes: InternalNote[] }>(this.base + '?key=' + encodeURIComponent(key))).notes; }
  async add(key: string, text: string, authorName: string, o: AddNote = {}) {
    return (await this.call<{ note: InternalNote }>(this.base, { method: 'POST', body: JSON.stringify({ key, text, authorName, ...o }) })).note;
  }
  async edit(id: number, text: string, mentions?: string[]) {
    return (await this.call<{ note: InternalNote }>(this.base + '/' + id, { method: 'PATCH', body: JSON.stringify({ text, mentions }) })).note;
  }
  async remove(id: number) { await this.call(this.base + '/' + id, { method: 'DELETE' }); }
  async activity(key: string) { return (await this.call<{ activity: NoteActivity[] }>(this.base + '/activity?key=' + encodeURIComponent(key))).activity; }
  async members() { return (await this.call<{ members: Mentionable[] }>(this.internal + '/members')).members; }
  async inbox() { return this.call<InternalInbox>(this.internal); }
  async markRead(ids?: number[]) { await this.call(this.internal + '/read', { method: 'POST', body: JSON.stringify(ids ? { ids } : {}) }); }
}
