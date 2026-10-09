import type { GoogleAuth } from './auth';

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export interface RequestOptions {
  method?: string;
  query?: Record<string, string | number | boolean | string[] | undefined>;
  json?: unknown;
  body?: BodyInit;
  headers?: Record<string, string>;
  /** Return the raw Response instead of parsed JSON. */
  raw?: boolean;
}

/**
 * Authenticated fetch for Google REST APIs. Retries once on 401 with a fresh
 * token, and backs off on 429 / 5xx (rate limits, transient errors).
 */
export class GoogleClient {
  constructor(private auth: GoogleAuth) {}

  async request<T>(url: string, o: RequestOptions = {}): Promise<T> {
    const u = new URL(url);
    for (const [k, v] of Object.entries(o.query || {})) {
      if (v === undefined || v === '') continue;
      if (Array.isArray(v)) v.forEach(x => u.searchParams.append(k, x));
      else u.searchParams.set(k, String(v));
    }
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const token = await this.auth.token();
      const res = await fetch(u, {
        method: o.method || (o.json !== undefined || o.body ? 'POST' : 'GET'),
        headers: {
          Authorization: 'Bearer ' + token,
          ...(o.json !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...o.headers
        },
        body: o.json !== undefined ? JSON.stringify(o.json) : o.body
      });
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        this.auth.invalidate();
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        await sleep(500 * 2 ** attempt + Math.random() * 250);
        continue;
      }
      if (!res.ok) {
        let msg = res.statusText || 'Request failed';
        try {
          const j = await res.json();
          msg = j?.error?.message || msg;
        } catch { /* not JSON */ }
        throw new ApiError(msg + ' (' + res.status + ')', res.status);
      }
      if (o.raw) return res as unknown as T;
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      return (text ? JSON.parse(text) : undefined) as T;
    }
  }
}

/** Run async tasks with a concurrency cap, preserving order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
