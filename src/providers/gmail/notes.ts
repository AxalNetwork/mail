import type { ActivityEvent } from '../../types';
import { messageTime } from '../../lib/format';

/**
 * Internal notes for a conversation, keyed by the RFC 5322 Message-ID of its
 * first message so every team member's mailbox resolves to the same notes.
 */
export interface NotesStore {
  /** Notes are visible to the whole team (backend), not just this device. */
  readonly shared: boolean;
  list(key: string): Promise<ActivityEvent[]>;
  add(key: string, text: string, authorName: string): Promise<void>;
}

const LOCAL_KEY = 'axal.notes';

function readLocal(): Record<string, ActivityEvent[]> {
  try { return JSON.parse(localStorage.getItem(LOCAL_KEY) || '{}'); } catch { return {}; }
}

/** Fallback when no backend is deployed: notes stay in this browser. */
export class LocalNotes implements NotesStore {
  readonly shared = false;
  async list(key: string) { return readLocal()[key] || []; }
  async add(key: string, text: string) {
    const all = readLocal();
    all[key] = [...(all[key] || []), { text: 'Internal note (this device): ' + text, time: messageTime(Date.now()) }];
    try { localStorage.setItem(LOCAL_KEY, JSON.stringify(all)); } catch { /* storage full or blocked */ }
  }
}

interface RemoteNote { text: string; author: string; createdAt: number }

/** Notes stored by the Axal VC Mail backend (Cloudflare D1), shared with the team. */
export class RemoteNotes implements NotesStore {
  readonly shared = true;
  constructor(private base: string, private token: () => Promise<string>) {}

  private async call<T>(init: RequestInit & { query?: string } = {}): Promise<T> {
    const res = await fetch(this.base + (init.query ? '?' + init.query : ''), {
      ...init,
      headers: { Authorization: 'Bearer ' + (await this.token()), ...(init.body ? { 'Content-Type': 'application/json' } : {}) }
    });
    if (!res.ok) {
      const j = await res.json().catch(() => null) as { error?: string } | null;
      throw new Error(j?.error || 'Notes request failed (' + res.status + ')');
    }
    return res.json() as Promise<T>;
  }

  async list(key: string) {
    const r = await this.call<{ notes: RemoteNote[] }>({ query: 'key=' + encodeURIComponent(key) });
    return r.notes.map(n => ({ text: 'Internal note · ' + n.author + ': ' + n.text, time: messageTime(n.createdAt) }));
  }

  async add(key: string, text: string, authorName: string) {
    await this.call({ method: 'POST', body: JSON.stringify({ key, text, authorName }) });
  }
}
