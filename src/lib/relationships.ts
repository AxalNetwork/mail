import type { ConversationStat } from '../types';
import { WAITING_ON_OTHERS_MS } from './analytics';

/**
 * Relationship indicators from conversation metadata the app already reads for
 * Analytics (who wrote, to whom, when; never content). Nothing here is stored.
 * There is deliberately no score: each indicator is a plain count or date.
 */

const DAY = 86_400_000;

export interface ConversationLink {
  id: string;
  subject: string;
  /** Latest message involving this person. */
  last: number;
  sent: number;
  received: number;
  /** Who wrote the latest message in the conversation. */
  lastFromMe: boolean;
}

export interface Activity {
  conversations: ConversationLink[];
  /** Epoch ms of the latest message to or from them, or null when none is in the sample. */
  lastInteraction: number | null;
  sent30: number;
  received30: number;
  /** Conversations in the last 90 days. */
  conversations90: number;
  /** They wrote last and nobody answered. */
  unanswered: ConversationLink[];
  /** You wrote last more than 3 days ago and they have not answered. */
  followUpsDue: ConversationLink[];
}

export function activityFor(emails: string[], sample: ConversationStat[], now: number): Activity {
  const mine = new Set(emails.map(e => e.toLowerCase()));
  // One entry per thread, even when the sample holds the same thread twice.
  const byId = new Map<string, ConversationLink>();
  for (const c of sample) {
    let sent = 0, received = 0, last = 0;
    for (const m of c.messages) {
      const involved = m.fromMe ? m.to.some(t => mine.has(t)) : mine.has(m.from);
      if (!involved || m.automated) continue;
      if (m.fromMe) sent++; else received++;
      last = Math.max(last, m.at);
    }
    if (!sent && !received) continue;
    const latest = c.messages[c.messages.length - 1];
    const prev = byId.get(c.id);
    if (prev) {
      prev.sent += sent; prev.received += received;
      if (last > prev.last) { prev.last = last; prev.lastFromMe = !!latest?.fromMe; }
    } else {
      byId.set(c.id, { id: c.id, subject: c.subject, last, sent, received, lastFromMe: !!latest?.fromMe });
    }
  }
  const links = [...byId.values()];
  links.sort((a, b) => b.last - a.last);
  const within = (ms: number) => (l: { at: number }) => now - l.at <= ms;
  const msgs = sample.flatMap(c => c.messages.filter(m => !m.automated && (m.fromMe ? m.to.some(t => mine.has(t)) : mine.has(m.from))));
  return {
    conversations: links,
    lastInteraction: links[0]?.last ?? null,
    sent30: msgs.filter(m => m.fromMe).filter(within(30 * DAY)).length,
    received30: msgs.filter(m => !m.fromMe).filter(within(30 * DAY)).length,
    conversations90: links.filter(l => now - l.last <= 90 * DAY).length,
    unanswered: links.filter(l => !l.lastFromMe && l.received > 0),
    followUpsDue: links.filter(l => l.lastFromMe && l.sent > 0 && now - l.last > WAITING_ON_OTHERS_MS)
  };
}

/** The user's rule for calling a relationship stale. Off means no stale indicator at all. */
export interface StaleRule { enabled: boolean; days: number }
export const DEFAULT_STALE: StaleRule = { enabled: true, days: 60 };
const RULE_KEY = 'axal.contacts.stale';

export function loadStaleRule(): StaleRule {
  try {
    const r = JSON.parse(localStorage.getItem(RULE_KEY) || 'null') as StaleRule | null;
    if (r && typeof r.enabled === 'boolean' && r.days >= 7 && r.days <= 730) return r;
  } catch { /* blocked storage */ }
  return DEFAULT_STALE;
}
export function saveStaleRule(r: StaleRule) {
  try { localStorage.setItem(RULE_KEY, JSON.stringify(r)); } catch { /* blocked storage */ }
}

/** Stale: no message either way for `days`, but there was one in the sample. Never stale when the rule is off or nothing is known. */
export function isStale(a: Activity, rule: StaleRule, now: number): boolean {
  return rule.enabled && a.lastInteraction != null && now - a.lastInteraction > rule.days * DAY;
}

// ---------- suggestions ----------

const FREEMAIL = /^(gmail|googlemail|outlook|hotmail|live|msn|yahoo|ymail|icloud|me|mac|aol|proton|protonmail|pm|gmx|mail|fastmail|hey|zoho)\.[a-z.]+$/;

export interface Suggestion {
  email: string;
  name: string;
  /** Organization guessed from the address domain; empty for personal mail providers. */
  domain: string;
  /** Where it came from: the latest conversation with them. */
  source: { id: string; subject: string; at: number };
  received: number;
  sent: number;
}

/**
 * People worth a record: real two-way correspondence (they wrote and you wrote
 * to them), outside the firm, not bulk mail, not already a contact. Not every
 * sender is a relationship, so one-way mail is left out.
 */
export function suggestContacts(sample: ConversationStat[], known: Set<string>, orgDomain: string, dismissed: Set<string>): Suggestion[] {
  const people = new Map<string, Suggestion>();
  const internal = (e: string) => !!orgDomain && e.endsWith('@' + orgDomain.toLowerCase());
  for (const c of sample) {
    for (const m of c.messages) {
      if (m.automated) continue;
      const addrs = m.fromMe ? m.to : [m.from];
      for (const e of addrs) {
        if (!e || known.has(e) || dismissed.has(e) || internal(e) || /no-?reply|notifications?@|mailer-daemon/i.test(e)) continue;
        const d = e.split('@')[1] || '';
        const s = people.get(e) || { email: e, name: '', domain: FREEMAIL.test(d) ? '' : d, source: { id: c.id, subject: c.subject, at: 0 }, received: 0, sent: 0 };
        if (m.fromMe) s.sent++; else { s.received++; if (m.fromName && m.fromName !== e) s.name = m.fromName; }
        if (m.at > s.source.at) s.source = { id: c.id, subject: c.subject, at: m.at };
        people.set(e, s);
      }
    }
  }
  return [...people.values()].filter(s => s.sent > 0 && s.received > 0).sort((a, b) => b.source.at - a.source.at).slice(0, 50);
}

const SUGGEST_KEY = 'axal.contacts.dismissedSuggestions';
export function loadDismissedSuggestions(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(SUGGEST_KEY) || '[]')); } catch { return new Set(); }
}
export function dismissSuggestion(email: string) {
  const s = loadDismissedSuggestions();
  s.add(email);
  try { localStorage.setItem(SUGGEST_KEY, JSON.stringify([...s].slice(-1000))); } catch { /* blocked storage */ }
}
