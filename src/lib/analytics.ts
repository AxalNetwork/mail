import type { ConversationStat, ConvMessage } from '../types';

/**
 * Mailbox analytics computed from conversation metadata (who wrote when),
 * in the browser. Nothing here reads message bodies, and nothing is stored.
 *
 * Definitions (shown in the UI too):
 * - Your response time: from an incoming message to your next message in the
 *   same conversation. Bulk / automated mail is ignored.
 * - Their response time: from your message to the next message from someone
 *   else in the conversation.
 * - Message reply rate: your messages that were followed by someone else's
 *   message in the same conversation, out of your messages that are old enough
 *   (24 h) to have had a chance.
 * - Contact reply rate: people you wrote to who wrote back in a conversation
 *   with you during the period, out of the people you wrote to.
 * - Waiting on others: conversations where you wrote last, more than 3 days ago.
 * - Waiting on you: conversations where a person (not bulk mail) wrote last
 *   and you haven't answered.
 */

const DAY = 86_400_000;
export const WAITING_ON_OTHERS_MS = 3 * DAY;

export interface DayCount { day: number; label: string; count: number }
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

function dayBuckets(from: number, to: number): DayCount[] {
  const out: DayCount[] = [];
  for (let d = startOfDay(from); d <= to; d = startOfDay(d + DAY + 3_600_000)) {
    out.push({ day: d, label: new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), count: 0 });
  }
  return out;
}

export function computeStats(convs: ConversationStat[], o: { now: number; days: number; orgDomain: string }): MailboxStats {
  const to = o.now;
  const from = startOfDay(o.now - (o.days - 1) * DAY);
  const inWin = (m: ConvMessage) => m.at >= from && m.at <= to;
  const sentByDay = dayBuckets(from, to);
  const receivedByDay = dayBuckets(from, to);
  const dayIndex = (t: number) => sentByDay.findIndex(b => b.day === startOfDay(t));
  const sentByHour = new Array<number>(24).fill(0);
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
    const ms = [...c.messages].sort((a, b) => a.at - b.at);
    if (!ms.some(inWin)) continue;
    active++;
    ms.forEach((m, i) => {
      const next = ms.slice(i + 1);
      if (m.fromMe) {
        if (inWin(m)) {
          sent++;
          const di = dayIndex(m.at);
          if (di >= 0) sentByDay[di].count++;
          sentByHour[new Date(m.at).getHours()]++;
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
    days: o.days, from, to,
    conversations: active,
    sent, received, receivedAutomated,
    sentByDay, receivedByDay, sentByHour,
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
