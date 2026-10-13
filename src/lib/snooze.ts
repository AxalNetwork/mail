/** Snooze times and the store that remembers them (the Worker, or this browser without one). */

const HOUR = 3_600_000;
const at = (base: Date, days: number, hour: number) => { const d = new Date(base); d.setDate(d.getDate() + days); d.setHours(hour, 0, 0, 0); return d.getTime(); };

export interface SnoozeOption { key: string; label: string; at: number }

/** The usual choices, in the browser's time zone. */
export function snoozeOptions(now: number): SnoozeOption[] {
  const d = new Date(now);
  const out: SnoozeOption[] = [];
  // Later today: three hours on, on the hour, while it's still the working day.
  const later = Math.ceil((now + 3 * HOUR) / HOUR) * HOUR;
  if (new Date(later).getDate() === d.getDate() && new Date(later).getHours() <= 20) out.push({ key: 'later', label: 'Later today', at: later });
  out.push({ key: 'tomorrow', label: 'Tomorrow', at: at(d, 1, 8) });
  const dow = d.getDay(); // 0 Sun … 6 Sat
  if (dow >= 1 && dow <= 5) out.push({ key: 'weekend', label: 'This weekend', at: at(d, 6 - dow, 9) });
  out.push({ key: 'week', label: 'Next week', at: at(d, ((8 - dow) % 7) || 7, 8) });
  return out;
}

/** "Tomorrow, 8:00 AM", "Sat, Oct 17, 9:00 AM". */
export function formatUntil(t: number, now: number): string {
  const time = new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const day0 = new Date(now); day0.setHours(0, 0, 0, 0);
  const diff = Math.floor((t - day0.getTime()) / 86_400_000);
  if (diff === 0) return 'Today, ' + time;
  if (diff === 1) return 'Tomorrow, ' + time;
  return new Date(t).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) + ', ' + time;
}

export interface Snooze { threadId: string; until: number; labelId: string; lastMessageId: string; createdBy?: string }

export interface SnoozeStore {
  /** The Worker brings conversations back on its own (otherwise the app does when it's open). */
  serverWakes(mailbox: string): Promise<boolean>;
  list(mailbox: string): Promise<Snooze[]>;
  set(mailbox: string, s: Snooze): Promise<void>;
  clear(mailbox: string, threadId: string, reason: 'unsnoozed' | 'woke'): Promise<void>;
}

export class HttpSnoozes implements SnoozeStore {
  constructor(private token: () => Promise<string>) {}
  private cache = new Map<string, { at: number; p: Promise<{ snoozes: Snooze[]; serverWakes: boolean }> }>();

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', 'Bearer ' + (await this.token()));
    if (init.body) headers.set('Content-Type', 'application/json');
    const res = await fetch('/api/snoozes' + path, { ...init, headers });
    const j = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new Error(j.error || 'Snooze request failed (' + res.status + ')');
    return j;
  }
  private load(mailbox: string) {
    const hit = this.cache.get(mailbox);
    if (hit && Date.now() - hit.at < 30_000) return hit.p;
    const p = this.call<{ snoozes: Snooze[]; serverWakes: boolean }>('?mailbox=' + encodeURIComponent(mailbox));
    this.cache.set(mailbox, { at: Date.now(), p });
    p.catch(() => this.cache.delete(mailbox));
    return p;
  }
  async serverWakes(mailbox: string) { return (await this.load(mailbox)).serverWakes; }
  async list(mailbox: string) { return (await this.load(mailbox)).snoozes; }
  async set(mailbox: string, s: Snooze) {
    this.cache.delete(mailbox);
    await this.call('', { method: 'POST', body: JSON.stringify({ mailbox, ...s }) });
  }
  async clear(mailbox: string, threadId: string, reason: 'unsnoozed' | 'woke') {
    this.cache.delete(mailbox);
    await this.call('?mailbox=' + encodeURIComponent(mailbox) + '&threadId=' + encodeURIComponent(threadId) + '&reason=' + reason, { method: 'DELETE' });
  }
}

const KEY = 'axal.snoozes.v1';

/** Without the backend: kept in this browser, and only this browser brings them back. */
export class LocalSnoozes implements SnoozeStore {
  private read(): Record<string, Snooze[]> { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; } }
  private write(v: Record<string, Snooze[]>) { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* storage full or blocked */ } }
  async serverWakes() { return false; }
  async list(mailbox: string) { return this.read()[mailbox] || []; }
  async set(mailbox: string, s: Snooze) {
    const all = this.read();
    all[mailbox] = [...(all[mailbox] || []).filter(x => x.threadId !== s.threadId), s];
    this.write(all);
  }
  async clear(mailbox: string, threadId: string) {
    const all = this.read();
    all[mailbox] = (all[mailbox] || []).filter(x => x.threadId !== threadId);
    this.write(all);
  }
}
