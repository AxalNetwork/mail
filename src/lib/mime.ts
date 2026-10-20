import type { Person, Priority } from '../types';

export interface MimeAttachment {
  name: string;
  mime: string;
  data: Uint8Array;
}

export interface MimeMessage {
  from: Person;
  to: Person[];
  cc: Person[];
  bcc: Person[];
  subject: string;
  html: string;
  text: string;
  attachments: MimeAttachment[];
  priority?: Priority;
  inReplyTo?: string;
  references?: string;
  date?: Date;
  boundarySeed?: string;
  /** Extra headers, e.g. List-Unsubscribe. Line breaks are stripped. */
  headers?: [string, string][];
}

const enc = new TextEncoder();

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/').replace(/\s/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function base64UrlDecodeText(b64url: string): string {
  return new TextDecoder().decode(base64ToBytes(b64url));
}

export function base64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function wrap76(s: string): string {
  return s.replace(/.{1,76}/g, '$&\r\n').replace(/\r\n$/, '');
}

const isAscii = (s: string) => /^[\x20-\x7e]*$/.test(s);

/** RFC 2047 encoded-word for non-ASCII header text. */
export function encodeHeader(s: string): string {
  if (isAscii(s)) return s;
  return '=?UTF-8?B?' + bytesToBase64(enc.encode(s)) + '?=';
}

export function formatAddress(p: Person): string {
  if (!p.name || p.name === p.email) return p.email;
  const name = isAscii(p.name) ? '"' + p.name.replace(/(["\\])/g, '\\$1') + '"' : encodeHeader(p.name);
  return name + ' <' + p.email + '>';
}

function headerParam(name: string): string {
  return isAscii(name) ? '"' + name.replace(/(["\\])/g, '\\$1') + '"' : '"' + encodeHeader(name) + '"';
}

function boundary(seed: string, n: number): string {
  return '=_axal_' + seed + '_' + n;
}

/** Build an RFC 5322 message: multipart/alternative body, wrapped in multipart/mixed when there are attachments. */
export function buildMime(m: MimeMessage): string {
  const seed = m.boundarySeed ?? Math.random().toString(36).slice(2, 12);
  const CRLF = '\r\n';
  const h: string[] = [];
  h.push('From: ' + formatAddress(m.from));
  if (m.to.length) h.push('To: ' + m.to.map(formatAddress).join(', '));
  if (m.cc.length) h.push('Cc: ' + m.cc.map(formatAddress).join(', '));
  if (m.bcc.length) h.push('Bcc: ' + m.bcc.map(formatAddress).join(', '));
  h.push('Subject: ' + encodeHeader(m.subject));
  h.push('Date: ' + (m.date ?? new Date()).toUTCString().replace('GMT', '+0000'));
  h.push('MIME-Version: 1.0');
  for (const [k, v] of m.headers || []) if (/^[A-Za-z][\w-]*$/.test(k)) h.push(k + ': ' + v.replace(/[\r\n]+/g, ' '));
  if (m.inReplyTo) h.push('In-Reply-To: ' + m.inReplyTo);
  if (m.references || m.inReplyTo) h.push('References: ' + [m.references, m.inReplyTo].filter(Boolean).join(' '));
  if (m.priority === 'High') h.push('X-Priority: 1', 'Importance: high');
  if (m.priority === 'Low') h.push('X-Priority: 5', 'Importance: low');

  const alt = boundary(seed, 1);
  const altPart =
    'Content-Type: multipart/alternative; boundary="' + alt + '"' + CRLF + CRLF +
    '--' + alt + CRLF +
    'Content-Type: text/plain; charset="UTF-8"' + CRLF +
    'Content-Transfer-Encoding: base64' + CRLF + CRLF +
    wrap76(bytesToBase64(enc.encode(m.text))) + CRLF +
    '--' + alt + CRLF +
    'Content-Type: text/html; charset="UTF-8"' + CRLF +
    'Content-Transfer-Encoding: base64' + CRLF + CRLF +
    wrap76(bytesToBase64(enc.encode(m.html))) + CRLF +
    '--' + alt + '--';

  if (!m.attachments.length) return h.join(CRLF) + CRLF + altPart + CRLF;

  const mixed = boundary(seed, 0);
  let body = 'Content-Type: multipart/mixed; boundary="' + mixed + '"' + CRLF + CRLF + '--' + mixed + CRLF + altPart + CRLF;
  for (const a of m.attachments) {
    body +=
      '--' + mixed + CRLF +
      'Content-Type: ' + (a.mime || 'application/octet-stream') + '; name=' + headerParam(a.name) + CRLF +
      'Content-Disposition: attachment; filename=' + headerParam(a.name) + CRLF +
      'Content-Transfer-Encoding: base64' + CRLF + CRLF +
      wrap76(bytesToBase64(a.data)) + CRLF;
  }
  body += '--' + mixed + '--' + CRLF;
  return h.join(CRLF) + CRLF + body;
}
