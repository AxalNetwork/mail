/** What a bug report carries besides the reporter's own words. Never mail content. */

declare const __APP_BUILD__: string;
export const APP_BUILD = typeof __APP_BUILD__ === 'string' ? __APP_BUILD__ : 'dev';

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
export const redactEmails = (s: string) => s.replace(EMAIL, '[email removed]');

const recent: string[] = [];

function remember(msg: string) {
  const m = redactEmails(msg).slice(0, 300);
  if (!m || recent[recent.length - 1] === m) return;
  recent.push(m);
  if (recent.length > 5) recent.shift();
}

let installed = false;
/** Keep the last few uncaught errors, so a report can say what broke. */
export function captureErrors() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('error', e => remember(e.message || String(e.error)));
  window.addEventListener('unhandledrejection', e => {
    const r = e.reason as { message?: string } | undefined;
    remember('Unhandled: ' + (r?.message || String(e.reason)));
  });
}

export interface ReportContext {
  view: string;
  path: string;
  build: string;
  userAgent: string;
  viewport: string;
  errors: string[];
}

export function reportContext(view: string): ReportContext {
  return {
    view,
    // The path only: search terms and ids in the query string stay out.
    path: location.pathname,
    build: APP_BUILD,
    userAgent: navigator.userAgent,
    viewport: window.innerWidth + '×' + window.innerHeight,
    errors: [...recent]
  };
}

export interface BugReport {
  title: string;
  description: string;
  context?: ReportContext;
}

export type ReportBug = (r: BugReport) => Promise<{ number: number; url: string }>;

export function httpReportBug(url: string, token: () => Promise<string>): ReportBug {
  return async r => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (await token()) },
      body: JSON.stringify(r)
    });
    const j = (await res.json().catch(() => ({}))) as { number?: number; url?: string; error?: string };
    if (!res.ok || !j.number || !j.url) throw new Error(j.error || 'The report could not be sent (' + res.status + ').');
    return { number: j.number, url: j.url };
  };
}
