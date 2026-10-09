import type { ComposeAttachment, Contact, Identity, Person } from '../types';

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const SENSITIVE_RE = /\b(commit(ment)?s?|term sheet|valuation|wire|allocation|capital call|fund terms|marks)\b/i;
const CONSUMER_DOMAINS = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com', 'proton.me']);

/** The org domain for an account address, or '' for consumer mail domains. */
export function orgDomainFor(email: string): string {
  const d = (email.split('@')[1] || '').toLowerCase();
  return CONSUMER_DOMAINS.has(d) ? '' : d;
}

export function isInternal(email: string, orgDomain: string): boolean {
  return !!orgDomain && email.toLowerCase().endsWith('@' + orgDomain);
}

/** Parse "Name <a@b.c>", a bare address, or a known contact's name. */
export function parsePerson(raw: string, known: Contact[] = []): Person | null {
  const q = raw.trim().replace(/[,;]$/, '').trim();
  if (!q) return null;
  const hit = known.find(p => p.email.toLowerCase() === q.toLowerCase() || p.name.toLowerCase() === q.toLowerCase());
  if (hit) return { name: hit.name, email: hit.email, org: hit.org };
  const angle = /^"?([^"<]*?)"?\s*<([^>]+)>$/.exec(q);
  const email = (angle ? angle[2] : q).trim();
  const name = angle && angle[1].trim() ? angle[1].trim() : email;
  const ok = EMAIL_RE.test(email);
  return { name, email, org: ok ? email.split('@')[1] : '', invalid: !ok };
}

/** Parse an address header such as `"Maya Chen" <maya@x.com>, bob@y.com`. */
export function parseAddressList(header: string): Person[] {
  if (!header) return [];
  const out: Person[] = [];
  let cur = '';
  let quoted = false;
  let angle = false;
  for (const ch of header) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && ch === '<') angle = true;
    if (!quoted && ch === '>') angle = false;
    if (ch === ',' && !quoted && !angle) {
      const p = parsePerson(cur);
      if (p) out.push(p);
      cur = '';
    } else cur += ch;
  }
  const p = parsePerson(cur);
  if (p) out.push(p);
  return out;
}

export interface CheckInput {
  identity: Identity;
  defaultIdentityId: string;
  to: Person[];
  cc: Person[];
  bcc: Person[];
  subject: string;
  text: string;
  attachments: ComposeAttachment[];
  orgDomain: string;
}

/** Reasons the send needs an explicit review step. Empty = send directly. */
export function sendChecks(c: CheckInput): string[] {
  const r: string[] = [];
  const all = [...c.to, ...c.cc, ...c.bcc];
  const ext = all.filter(p => !isInternal(p.email, c.orgDomain));
  const restricted = c.attachments.filter(a => a.cls === 'Confidential' || a.cls === 'Restricted');
  if (ext.length && restricted.length) {
    r.push(restricted.map(a => a.name).join(', ') + ' is classified ' + restricted.map(a => a.cls).join('/') +
      ' and will go to external recipients as a secure, named-recipient link.');
  }
  const txt = c.subject + ' ' + c.text;
  const m = txt.match(SENSITIVE_RE);
  if (ext.length && m) r.push('The message mentions fund or investment terms ("' + m[0] + '"). Check that nothing reads as a commitment.');
  if (c.identity.id !== c.defaultIdentityId) r.push('You are sending as ' + c.identity.name + ' <' + c.identity.addr + '>, not from your own mailbox.');
  if (all.length > 10) r.push(all.length + ' recipients. Consider Bcc or a shared inbox.');
  return r;
}

export function validateRecipients(to: Person[], cc: Person[], bcc: Person[]): string | null {
  const all = [...to, ...cc, ...bcc];
  if (!all.length) return 'Add at least one recipient.';
  if (all.some(p => p.invalid)) return 'One or more addresses are not valid. Fix or remove the highlighted recipient.';
  return null;
}
