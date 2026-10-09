import type { AttachmentRef, Message, Person, ThreadSummary } from '../../types';
import { base64UrlDecodeText } from '../../lib/mime';
import { htmlToText } from '../../lib/html';
import { fileExt, listTime, messageTime } from '../../lib/format';
import { parseAddressList } from '../../lib/compose';

// Shapes of the Gmail API resources we read (subset).
export interface GmailHeader { name: string; value: string }
export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
}
export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailPart;
}
export interface GmailThread {
  id: string;
  snippet?: string;
  historyId?: string;
  messages?: GmailMessage[];
}
export interface GmailLabel {
  id: string;
  name: string;
  type?: 'system' | 'user';
  threadsUnread?: number;
  threadsTotal?: number;
  messagesTotal?: number;
}

export function header(m: GmailMessage | GmailPart | undefined, name: string): string {
  const hs = (m && 'payload' in m ? m.payload?.headers : (m as GmailPart | undefined)?.headers) || [];
  const n = name.toLowerCase();
  return hs.find(h => h.name.toLowerCase() === n)?.value || '';
}

export function firstPerson(h: string): Person {
  return parseAddressList(h)[0] || { name: h || '(unknown)', email: '', org: '' };
}

/** Decode HTML entities that Gmail leaves in snippets (&#39; etc.). */
export function decodeEntities(s: string): string {
  const t = document.createElement('textarea');
  t.innerHTML = s;
  return t.value;
}

interface Bodies { text: string; html: string; attachments: AttachmentRef[] }

function walk(part: GmailPart | undefined, messageId: string, acc: Bodies) {
  if (!part) return;
  const mime = (part.mimeType || '').toLowerCase();
  const disposition = header(part, 'Content-Disposition').toLowerCase();
  if (part.filename && (part.body?.attachmentId || disposition.startsWith('attachment'))) {
    acc.attachments.push({
      name: part.filename, ext: fileExt(part.filename), size: part.body?.size || 0, mime: part.mimeType || 'application/octet-stream',
      messageId, attachmentId: part.body?.attachmentId
    });
    return;
  }
  if (part.parts?.length) {
    for (const p of part.parts) walk(p, messageId, acc);
    return;
  }
  const data = part.body?.data;
  if (!data) return;
  if (mime === 'text/plain' && !acc.text) acc.text = base64UrlDecodeText(data);
  else if (mime === 'text/html' && !acc.html) acc.html = base64UrlDecodeText(data);
}

export function messageBodies(m: GmailMessage): Bodies {
  const acc: Bodies = { text: '', html: '', attachments: [] };
  walk(m.payload, m.id, acc);
  if (!acc.text && acc.html) acc.text = htmlToText(acc.html);
  return acc;
}

const nameList = (h: string) => parseAddressList(h).map(p => (p.name && p.name !== p.email ? p.name : p.email)).join('; ');

export function toMessage(m: GmailMessage, now = new Date()): Message {
  const from = firstPerson(header(m, 'From'));
  const b = messageBodies(m);
  const date = Number(m.internalDate || 0);
  return {
    id: m.id,
    from: from.name,
    email: from.email,
    to: nameList(header(m, 'To')) || '—',
    cc: nameList(header(m, 'Cc')) || undefined,
    recipients: [...parseAddressList(header(m, 'To')), ...parseAddressList(header(m, 'Cc'))],
    time: date ? messageTime(date, now) : '',
    date,
    text: b.text,
    html: b.html || undefined,
    attachments: b.attachments,
    messageIdHeader: header(m, 'Message-ID') || header(m, 'Message-Id') || undefined,
    references: header(m, 'References') || undefined
  };
}

export interface SummaryOptions {
  me: string;
  labelNames: Map<string, string>;
  now?: Date;
}

/**
 * Row data for a thread fetched with format=metadata. In Sent/Drafts the row
 * shows the recipients; elsewhere it shows the latest sender who isn't you.
 */
export function toSummary(t: GmailThread, o: SummaryOptions): ThreadSummary {
  const msgs = t.messages || [];
  const last = msgs[msgs.length - 1];
  const first = msgs[0];
  const me = o.me.toLowerCase();
  const labelIds = new Set(msgs.flatMap(m => m.labelIds || []));
  const outgoingOnly = msgs.every(m => (m.labelIds || []).some(l => l === 'SENT' || l === 'DRAFT'));
  let who: Person;
  if (outgoingOnly) {
    const rcpts = parseAddressList(header(last, 'To'));
    who = rcpts.length
      ? { name: rcpts.map(p => (p.name !== p.email ? p.name : p.email)).join(', '), email: rcpts[0].email, org: rcpts[0].org }
      : { name: '(no recipients)', email: '', org: '' };
  } else {
    const incoming = [...msgs].reverse().find(m => firstPerson(header(m, 'From')).email.toLowerCase() !== me) || last;
    who = firstPerson(header(incoming, 'From'));
  }
  const date = Number(last?.internalDate || 0);
  const subject = header(first, 'Subject') || header(last, 'Subject') || '(no subject)';
  const labels = [...labelIds].filter(id => !id.startsWith('CATEGORY_') && o.labelNames.has(id)).map(id => o.labelNames.get(id)!);
  const attachCount = msgs.reduce((n, m) => n + countAttachmentHints(m), 0);
  return {
    id: t.id,
    from: who.name + (msgs.length > 1 ? ' (' + msgs.length + ')' : ''),
    org: who.org,
    email: who.email,
    time: date ? listTime(date, o.now) : '',
    date,
    subject,
    snippet: decodeEntities(last?.snippet || t.snippet || ''),
    labels,
    unread: labelIds.has('UNREAD'),
    starred: labelIds.has('STARRED'),
    attachCount,
    outgoing: outgoingOnly
  };
}

/** Metadata responses carry no parts, but multipart/mixed is a reliable attachment hint. */
function countAttachmentHints(m: GmailMessage): number {
  const ct = header(m, 'Content-Type').toLowerCase();
  return ct.startsWith('multipart/mixed') ? 1 : 0;
}
