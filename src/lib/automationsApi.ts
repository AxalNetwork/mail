/** Dismissed automation suggestions: kept by the Worker (/api/automations/dismissed), or on this device without one. */

export type DismissKind = 'follow_up' | 'reply' | 'triage';
export type Dismissed = Record<DismissKind, string[]>;

export interface DismissalStore {
  /** Shared across the member's devices (otherwise this browser only). */
  readonly shared: boolean;
  load(): Promise<Dismissed>;
  dismiss(kind: DismissKind, key: string): Promise<void>;
  restore(kind: DismissKind, key: string): Promise<void>;
}

const empty = (): Dismissed => ({ follow_up: [], reply: [], triage: [] });

export class HttpDismissals implements DismissalStore {
  readonly shared = true;
  constructor(private token: () => Promise<string>) {}

  private async call<T>(method: string, body?: unknown): Promise<T> {
    const headers = new Headers({ Authorization: 'Bearer ' + (await this.token()) });
    if (body) headers.set('Content-Type', 'application/json');
    const res = await fetch('/api/automations/dismissed', { method, headers, body: body ? JSON.stringify(body) : undefined });
    const j = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new Error(j.error || 'Request failed (' + res.status + ')');
    return j;
  }

  async load() { return { ...empty(), ...(await this.call<{ dismissed: Dismissed }>('GET')).dismissed }; }
  async dismiss(kind: DismissKind, key: string) { await this.call('POST', { kind, key }); }
  async restore(kind: DismissKind, key: string) { await this.call('DELETE', { kind, key }); }
}

const LOCAL_KEY = 'axal.automations.dismissed';

export class LocalDismissals implements DismissalStore {
  readonly shared = false;
  private read(): Dismissed {
    try { return { ...empty(), ...JSON.parse(localStorage.getItem(LOCAL_KEY) || '{}') }; } catch { return empty(); }
  }
  private write(d: Dismissed) {
    try { localStorage.setItem(LOCAL_KEY, JSON.stringify(d)); } catch { /* storage full or blocked */ }
  }
  async load() { return this.read(); }
  async dismiss(kind: DismissKind, key: string) {
    const d = this.read();
    if (!d[kind].includes(key)) d[kind] = [...d[kind], key].slice(-500);
    this.write(d);
  }
  async restore(kind: DismissKind, key: string) {
    const d = this.read();
    d[kind] = d[kind].filter(k => k !== key);
    this.write(d);
  }
}

/** A follow-up or reply suggestion comes back once the conversation moves on (a newer message changes `since`). */
export const waitingKey = (id: string, since: number) => id + ':' + since;
