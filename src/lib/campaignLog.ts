import type { ConversationStat } from '../types';

/**
 * A record of each bulk email run, kept in this browser only (localStorage):
 * when, the subject, the sending address, counts, and the Gmail thread id of
 * each message Gmail accepted. No message text and no server copy. Outcomes
 * are worked out later from the same conversation metadata Analytics reads.
 */

export interface CampaignRecord {
  id: string;
  at: number;
  subject: string;
  from: string;
  /** Recipients the run tried. */
  total: number;
  /** Gmail accepted these for sending (not a delivery confirmation). */
  accepted: { email: string; threadId: string }[];
  /** Saved to Drafts for partner approval instead of sent. */
  held: number;
  failed: number;
  scheduled: boolean;
  /** Stopped before every recipient was processed. */
  stopped: boolean;
}

const KEY = 'axal.campaigns.v1';
const MAX = 50;

export function loadCampaigns(): CampaignRecord[] {
  try { const v = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}

export function saveCampaign(r: CampaignRecord) {
  try { localStorage.setItem(KEY, JSON.stringify([r, ...loadCampaigns().filter(x => x.id !== r.id)].slice(0, MAX))); } catch { /* storage full or blocked */ }
}

export function forgetCampaigns() {
  try { localStorage.removeItem(KEY); } catch { /* blocked */ }
}

export interface CampaignOutcome {
  /** A person wrote in the thread after the send. */
  replied: number;
  /** A bounce notice (mailer-daemon / postmaster) arrived in the thread. */
  bounceNotices: number;
  /** In the period read, with nothing after the send. Not a failure: delivery is unknown. */
  noReplySeen: number;
  /** The thread isn't in the conversations read for this period. */
  notInSample: number;
}

const BOUNCE = /^(mailer-daemon|postmaster)@/i;

export function campaignOutcome(r: CampaignRecord, sample: ConversationStat[]): CampaignOutcome {
  const byId = new Map(sample.map(c => [c.id, c]));
  const out: CampaignOutcome = { replied: 0, bounceNotices: 0, noReplySeen: 0, notInSample: 0 };
  for (const a of r.accepted) {
    const c = byId.get(a.threadId);
    if (!c) { out.notInSample++; continue; }
    const after = c.messages.filter(m => m.at > r.at && !m.fromMe);
    if (after.some(m => BOUNCE.test(m.from))) out.bounceNotices++;
    else if (after.some(m => !m.automated)) out.replied++;
    else out.noReplySeen++;
  }
  return out;
}
