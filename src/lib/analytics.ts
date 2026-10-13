import type { ConversationStat, ConvMessage } from '../types';

/**
 * Mailbox analytics computed from conversation metadata (who wrote when),
 * in the browser. Nothing here reads message bodies, and nothing is stored.
 *
 * Definitions (shown in the UI too):
 * - Time to first response: in a conversation someone else started (inside the
 *   period), from their first message to your first message after it.
 * - Your response time (time between replies): from each incoming message to
 *   your next message in the same conversation. Bulk / automated mail is ignored.
 * - Their response time: from your message to the next message from someone
 *   else in the conversation.
 * - Message reply rate: your messages that were followed by someone else's
 *   message in the same conversation, out of your messages that are old enough
 *   (24 h) to have had a chance.
 * - Contact reply rate: people you wrote to who wrote back in a conversation
 *   with you during the period, out of the people you wrote to.
 * - Waiting on others: conversations where you wrote last, more than 3 days ago.
 * - Waiting on you: conversations where a person (not bulk mail) wrote last
 *   and you haven't answered. Unanswered is not the same as a missed
 *   commitment: many messages need no reply.
 * - Days and weeks are in the browser's time zone; weeks start on Monday.
 * - A message seen twice (same Message-ID, e.g. in two mailboxes) counts once;
 *   messages without a date are left out and counted in `missingTime`.
 */

const DAY = 86_400_000;
export const WAITING_ON_OTHERS_MS = 3 * DAY;

export interface DayCount { day: number; label: string; count: number }
export interface Bucket { label: string; count: number }
/** Response-time ranges, upper bounds in ms. */
export const RESPONSE_BUCKETS: [string, number][] = [['< 1 h', 3_600_000], ['1–4 h', 4 * 3_600_000], ['4–24 h', DAY], ['1–3 days', 3 * DAY], ['> 3 days', Infinity]];
export interface Contact { email: string; name: string; sent: number; received: number; last: number }
export interface WaitingItem { id: string; subject: string; who: string; email: string; since: number }

export interface MailboxStats {
  days: number;
  from: number;
  to: number;
  conversations: number;
  sent: number;
  received: number;
  receivedAutomated: number;
  sentByDay: DayCount[];
  receivedByDay: DayCount[];
  sentByHour: number[];
  /** Weeks start on Monday (local time). */
  sentByWeek: DayCount[];
  receivedByWeek: DayCount[];
  /** Conversations with at least one message in that week. */
  activeByWeek: DayCount[];
  firstResponseMs: number | null;
  firstResponseCount: number;
  firstResponseDist: Bucket[];
  /** Distribution of your response times (each reply). */
  replyDist: Bucket[];
  theirDist: Bucket[];
  /** Repeated messages that were counted once. */
  duplicates: number;
  /** Messages without a usable date, left out. */
  missingTime: number;
  /** Median ms, or null without data. */
  myResponseMs: number | null;
  myResponseCount: number;
  theirResponseMs: number | null;
  theirResponseCount: number;
  messageReplyRate: number | null;
  messageReplyBase: number;
  contactReplyRate: number | null;
  contactsWritten: number;
  contactsReplied: number;
  waitingOnOthers: WaitingItem[];
  waitingOnYou: WaitingItem[];
  topContacts: Contact[];
  /** Share of your messages that only went to your organization. */
  internalShare: number | null;
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const startOfDay = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
/** Local midnight of the Monday on or before `t`. */
export const startOfWeek = (t: number) => { const d = new Date(startOfDay(t)); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); };

function weekBuckets(from: number, to: number): DayCount[] {
  const out: DayCount[] = [];
  for (let w = startOfWeek(from); w <= to; w = startOfWeek(w + 7 * DAY + 3_600_000)) {
    out.push({ day: w, label: 'Week of ' + new Date(w).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), count: 0 });
  }
  return out;
}

export function distribution(xs: number[]): Bucket[] {
  const out = RESPONSE_BUCKETS.map(([label]) => ({ label, count: 0 }));
  for (const x of xs) out[RESPONSE_BUCKETS.findIndex(([, max]) => x < max)].count++;
  return out;
}

function dayBuckets(from: number, to: number): DayCount[] {
  const out: DayCount[] = [];
  for (let d = startOfDay(from); d <= to; d = startOfDay(d + DAY + 3_600_000)) {
    out.push({ day: d, label: new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), count: 0 });
  }
  return out;
}

/**
 * `from`/`to` set an explicit window (epoch ms, inclusive); otherwise the last
 * `days` days up to `now`, from local midnight.
 */
export function computeStats(convs: ConversationStat[], o: { now: number; days: number; orgDomain: string; from?: number; to?: number }): MailboxStats {
  const to = o.to ?? o.now;
  const from = o.from ?? startOfDay(o.now - (o.days - 1) * DAY);
  const inWin = (m: ConvMessage) => m.at >= from && m.at <= to;
  const sentByDay = dayBuckets(from, to);
  const receivedByDay = dayBuckets(from, to);
  const dayIndex = (t: number) => sentByDay.findIndex(b => b.day === startOfDay(t));
  const sentByHour = new Array<number>(24).fill(0);
  const sentByWeek = weekBuckets(from, to);
  const receivedByWeek = weekBuckets(from, to);
  const activeByWeek = weekBuckets(from, to);
  const weekIndex = (t: number) => sentByWeek.findIndex(b => b.day === startOfWeek(t));
  const firstResp: number[] = [];
  const seen = new Set<string>();
  let duplicates = 0, missingTime = 0;
  const myResp: number[] = [];
  const theirResp: number[] = [];
  let sent = 0, received = 0, receivedAutomated = 0, replyBase = 0, replied = 0, internalOnly = 0;
  const written = new Set<string>();
  const wroteBack = new Set<string>();
  const contacts = new Map<string, Contact>();
  const waitingOnOthers: WaitingItem[] = [];
  const waitingOnYou: WaitingItem[] = [];
  const org = o.orgDomain.toLowerCase();
  const touch = (email: string, name: string, at: number, k: 'sent' | 'received') => {
    if (!email) return;
    const c = contacts.get(email) || { email, name: name || email, sent: 0, received: 0, last: 0 };
    c[k]++;
    c.last = Math.max(c.last, at);
    if (name && c.name === email) c.name = name;
    contacts.set(email, c);
  };
  let active = 0;

  for (const c of convs) {
    const ms = c.messages.filter(m => {
      if (!Number.isFinite(m.at) || m.at <= 0) { missingTime++; return false; }
      if (m.id) {
        if (seen.has(m.id)) { duplicates++; return false; }
        seen.add(m.id);
      }
      return true;
    }).sort((a, b) => a.at - b.at);
    if (!ms.some(inWin)) continue;
    active++;
    const weeks = new Set(ms.filter(inWin).map(m => weekIndex(m.at)).filter(i => i >= 0));
    for (const w of weeks) activeByWeek[w].count++;
    const first = ms[0];
    if (!first.fromMe && !first.automated && inWin(first)) {
      const mine = ms.find(m => m.fromMe);
      if (mine) firstResp.push(mine.at - first.at);
    }
    ms.forEach((m, i) => {
      const next = ms.slice(i + 1);
      if (m.fromMe) {
        if (inWin(m)) {
          sent++;
          const di = dayIndex(m.at);
          if (di >= 0) sentByDay[di].count++;
          sentByHour[new Date(m.at).getHours()]++;
          const wi = weekIndex(m.at);
          if (wi >= 0) sentByWeek[wi].count++;
          if (org && m.to.length && m.to.every(a => a.endsWith('@' + org))) internalOnly++;
          for (const a of m.to) { written.add(a); touch(a, '', m.at, 'sent'); }
          const answer = next.find(n => !n.fromMe);
          if (m.at <= to - DAY) {
            replyBase++;
            if (answer) replied++;
          }
          // Only the first of a run of your messages starts the clock for them.
          const prev = ms[i - 1];
          if (answer && (!prev || !prev.fromMe)) theirResp.push(answer.at - m.at);
        }
      } else {
        if (inWin(m)) {
          if (m.automated) receivedAutomated++;
          else {
            received++;
            const di = dayIndex(m.at);
            if (di >= 0) receivedByDay[di].count++;
            const wi = weekIndex(m.at);
            if (wi >= 0) receivedByWeek[wi].count++;
            touch(m.from, m.fromName, m.at, 'received');
            if (ms.slice(0, i).some(p => p.fromMe)) wroteBack.add(m.from);
            const mine = next.find(n => n.fromMe);
            const prev = ms[i - 1];
            if (mine && (!prev || prev.fromMe)) myResp.push(mine.at - m.at);
          }
        }
      }
    });

    const last = ms[ms.length - 1];
    if (last.fromMe) {
      if (to - last.at > WAITING_ON_OTHERS_MS && last.to.length) {
        const who = last.to[0] || '';
        waitingOnOthers.push({ id: c.id, subject: c.subject, who: contacts.get(who)?.name || who, email: who, since: last.at });
      }
    } else if (!last.automated) {
      waitingOnYou.push({ id: c.id, subject: c.subject, who: last.fromName || last.from, email: last.from, since: last.at });
    }
  }

  const replyRate = replyBase ? replied / replyBase : null;
  const contactsReplied = [...written].filter(e => wroteBack.has(e)).length;
  return {
    days: Math.max(1, Math.round((startOfDay(to) - from) / DAY) + 1), from, to,
    conversations: active,
    sent, received, receivedAutomated,
    sentByDay, receivedByDay, sentByHour, sentByWeek, receivedByWeek, activeByWeek,
    firstResponseMs: median(firstResp), firstResponseCount: firstResp.length, firstResponseDist: distribution(firstResp),
    replyDist: distribution(myResp), theirDist: distribution(theirResp), duplicates, missingTime,
    myResponseMs: median(myResp), myResponseCount: myResp.length,
    theirResponseMs: median(theirResp), theirResponseCount: theirResp.length,
    messageReplyRate: replyRate, messageReplyBase: replyBase,
    contactReplyRate: written.size ? contactsReplied / written.size : null,
    contactsWritten: written.size, contactsReplied,
    waitingOnOthers: waitingOnOthers.sort((a, b) => a.since - b.since),
    waitingOnYou: waitingOnYou.sort((a, b) => a.since - b.since),
    topContacts: [...contacts.values()].sort((a, b) => b.sent + b.received - (a.sent + a.received) || b.last - a.last).slice(0, 8),
    internalShare: sent ? internalOnly / sent : null
  };
}

/** Plain-language observations backed by the numbers above. Never causal claims. */
export function insights(s: MailboxStats): string[] {
  const out: string[] = [];
  const old = s.waitingOnYou.filter(w => s.to - w.since > 2 * DAY);
  if (old.length) out.push(old.length + ' conversation' + (old.length === 1 ? '' : 's') + ' from people have waited more than 2 days for your reply.');
  if (s.waitingOnOthers.length) out.push(s.waitingOnOthers.length + ' conversation' + (s.waitingOnOthers.length === 1 ? ' is' : 's are') + ' waiting on someone else for more than 3 days: candidates for a follow-up.');
  if (s.myResponseMs != null) out.push('Your median response time is ' + duration(s.myResponseMs) + ' across ' + s.myResponseCount + ' replies.');
  if (s.messageReplyRate != null && s.messageReplyBase >= 5) out.push(Math.round(s.messageReplyRate * 100) + '% of your messages got a reply in the same conversation.');
  const peak = s.sentByHour.indexOf(Math.max(...s.sentByHour));
  if (s.sent >= 10) out.push('You send the most email around ' + hourLabel(peak) + '.');
  if (s.receivedAutomated > s.received && s.receivedAutomated > 20) out.push('Bulk and automated mail (' + s.receivedAutomated + ') outnumbers mail from people (' + s.received + ').');
  return out;
}

export function duration(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return m + ' min';
  const h = ms / 3_600_000;
  if (h < 48) return (h < 10 ? h.toFixed(1) : Math.round(h)) + ' h';
  return Math.round(h / 24) + ' days';
}

export function hourLabel(h: number): string {
  return new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric' });
}

export function ago(t: number, now: number): string {
  return duration(Math.max(0, now - t)) + ' ago';
}

const csvCell = (v: string | number) => { const t = String(v); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };

/** The figures on screen as CSV: a summary, then one row per day. Counts and durations only; no addresses or subjects. */
export function statsCsv(s: MailboxStats, mailbox: string): string {
  const d = (ms: number | null) => (ms == null ? '' : (ms / 3_600_000).toFixed(2));
  const day = (t: number) => { const x = new Date(t); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); };
  const rows: (string | number)[][] = [
    ['Mailbox', mailbox], ['From', day(s.from)], ['To', day(s.to)],
    ['Conversations', s.conversations], ['Sent', s.sent], ['Received from people', s.received], ['Bulk / automated received', s.receivedAutomated],
    ['Median time to first response (h)', d(s.firstResponseMs)], ['First responses measured', s.firstResponseCount],
    ['Median your response time (h)', d(s.myResponseMs)], ['Your replies measured', s.myResponseCount],
    ['Median their response time (h)', d(s.theirResponseMs)], ['Their replies measured', s.theirResponseCount],
    ['Message reply rate', s.messageReplyRate == null ? '' : s.messageReplyRate.toFixed(3)],
    ['Waiting on you', s.waitingOnYou.length], ['Waiting on others', s.waitingOnOthers.length],
    [],
    ['Date', 'Sent', 'Received from people'],
    ...s.sentByDay.map((b, i) => [day(b.day), b.count, s.receivedByDay[i].count])
  ];
  return rows.map(r => r.map(csvCell).join(',')).join('\n') + '\n';
}
