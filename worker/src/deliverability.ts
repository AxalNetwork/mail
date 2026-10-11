import type { Env } from './env';
import { allowedDomains } from './auth';
import { HttpError } from './http';

/**
 * Sender authentication for the organization's domain, read from public DNS
 * (Cloudflare DNS over HTTPS). DNS shows what is configured; it can't prove
 * that every message passes, or where mail lands.
 */

export type Level = 'good' | 'warning' | 'critical';
export interface Check { key: 'mx' | 'spf' | 'dkim' | 'dmarc'; label: string; level: Level; summary: string; record?: string; advice?: string }

async function txt(name: string, type: 'TXT' | 'MX' = 'TXT'): Promise<string[]> {
  const res = await fetch('https://cloudflare-dns.com/dns-query?name=' + encodeURIComponent(name) + '&type=' + type, {
    headers: { Accept: 'application/dns-json' }
  });
  if (!res.ok) throw new HttpError(502, 'DNS lookup failed for ' + name);
  const j = (await res.json()) as { Answer?: { type: number; data: string }[] };
  // TXT data comes quoted and possibly split into several strings.
  return (j.Answer || []).filter(a => a.type === (type === 'TXT' ? 16 : 15))
    .map(a => (type === 'TXT' ? a.data.replace(/"\s*"/g, '').replace(/^"|"$/g, '') : a.data));
}

export async function checkDomain(domain: string): Promise<Check[]> {
  const [mx, root, dkim, dmarc] = await Promise.all([
    txt(domain, 'MX'), txt(domain), txt('google._domainkey.' + domain), txt('_dmarc.' + domain)
  ]);
  const out: Check[] = [];

  const google = mx.some(r => /google(mail)?\.com\.?$/i.test(r));
  out.push(mx.length
    ? { key: 'mx', label: 'Mail servers (MX)', level: 'good', summary: google ? 'Mail is delivered to Google Workspace.' : mx.length + ' mail server record(s).', record: mx.join('\n') }
    : { key: 'mx', label: 'Mail servers (MX)', level: 'critical', summary: 'No MX records: mail to this domain cannot be delivered.', advice: 'Add the MX records from Google Workspace (Admin console → Domains).' });

  const spf = root.filter(r => /^v=spf1\b/i.test(r));
  if (!spf.length) out.push({ key: 'spf', label: 'SPF', level: 'critical', summary: 'No SPF record. Receivers can’t tell which servers may send for ' + domain + '.', advice: 'Add a TXT record: v=spf1 include:_spf.google.com ~all' });
  else if (spf.length > 1) out.push({ key: 'spf', label: 'SPF', level: 'critical', summary: 'Several SPF records: receivers treat this as an error.', record: spf.join('\n'), advice: 'Merge them into one v=spf1 record.' });
  else {
    const r = spf[0];
    const hasGoogle = /include:_spf\.google\.com/i.test(r);
    const all = /[-~?+]all\b/.exec(r)?.[0] || '';
    const lookups = (r.match(/\b(include|a|mx|ptr|exists|redirect)[:=]?/gi) || []).length;
    const issues = [
      !hasGoogle && 'it doesn’t include Google Workspace (include:_spf.google.com)',
      (all === '+all' || all === '?all' || !all) && 'it doesn’t end with ~all or -all, so anyone can pass',
      lookups > 10 && 'it needs more than 10 DNS lookups, which receivers reject'
    ].filter(Boolean) as string[];
    out.push(issues.length
      ? { key: 'spf', label: 'SPF', level: 'warning', summary: 'SPF is published, but ' + issues.join('; ') + '.', record: r }
      : { key: 'spf', label: 'SPF', level: 'good', summary: 'Authorizes Google Workspace and ends with ' + all + '.', record: r });
  }

  const dk = dkim.find(r => /\bp=/.test(r));
  out.push(dk && !/\bp=\s*(;|$)/.test(dk)
    ? { key: 'dkim', label: 'DKIM', level: 'good', summary: 'Google Workspace signing key published (selector “google”).', record: dk.length > 90 ? dk.slice(0, 90) + '…' : dk }
    : { key: 'dkim', label: 'DKIM', level: 'warning', summary: 'No DKIM key at the default Google selector (google._domainkey).', advice: 'Admin console → Apps → Google Workspace → Gmail → Authenticate email: generate a key, publish the TXT record, then click Start authentication. (A custom selector would not show here.)' });

  const dm = dmarc.find(r => /^v=DMARC1\b/i.test(r));
  if (!dm) out.push({ key: 'dmarc', label: 'DMARC', level: 'critical', summary: 'No DMARC policy. Gmail and Yahoo require one for bulk senders, and it protects the domain from spoofing.', advice: 'Add a TXT record at _dmarc.' + domain + ': v=DMARC1; p=none; rua=mailto:dmarc@' + domain + ' then tighten to quarantine once reports look clean.' });
  else {
    const p = (/\bp=(\w+)/i.exec(dm)?.[1] || '').toLowerCase();
    const rua = /\brua=/i.test(dm);
    out.push({
      key: 'dmarc', label: 'DMARC', record: dm,
      level: p === 'none' || !rua ? 'warning' : 'good',
      summary: (p === 'reject' ? 'Policy: reject spoofed mail.' : p === 'quarantine' ? 'Policy: send spoofed mail to spam.' : 'Policy: monitor only (p=none); spoofed mail is still delivered.') +
        (rua ? ' Aggregate reports are requested.' : ' No reporting address (rua), so you get no reports.'),
      advice: p === 'none' ? 'Once reports show your own mail passing, move to p=quarantine, then p=reject.' : undefined
    });
  }
  return out;
}

/** GET /api/analytics/deliverability — only for the organization's own domains. */
export async function deliverability(env: Env, url: URL) {
  const domains = allowedDomains(env);
  const domain = (url.searchParams.get('domain') || domains[0] || '').toLowerCase();
  if (!domains.includes(domain)) throw new HttpError(400, 'Only ' + domains.join(', ') + ' can be checked.');
  return { domain, checkedAt: Date.now(), checks: await checkDomain(domain) };
}
