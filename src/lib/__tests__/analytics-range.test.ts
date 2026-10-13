import { computeStats, distribution, startOfWeek, statsCsv } from '../analytics';
import { campaignOutcome, loadCampaigns, saveCampaign, type CampaignRecord } from '../campaignLog';
import type { ConversationStat, ConvMessage } from '../../types';

// Days and weeks follow the browser's zone: pin one with a DST change (Toronto, Nov 1 2026).
process.env.TZ = 'America/Toronto';

const H = 3_600_000;
const DAY = 24 * H;
const at = (y: number, mo: number, d: number, h = 12) => new Date(y, mo - 1, d, h).getTime();
const me = (t: number, to = ['maya@n.example'], id?: string): ConvMessage => ({ id, from: 'julian@axal.vc', fromName: 'Julian', fromMe: true, to, at: t, automated: false });
const them = (t: number, from = 'maya@n.example', id?: string, automated = false): ConvMessage => ({ id, from, fromName: 'Maya', fromMe: false, to: [], at: t, automated });
const conv = (id: string, ...messages: ConvMessage[]): ConversationStat => ({ id, subject: 'Subject ' + id, messages });

describe('date windows and time zones', () => {
  it('includes both ends of a custom range and nothing outside it', () => {
    const from = at(2026, 10, 5, 0), to = at(2026, 10, 11, 0) + DAY - 1;
    const s = computeStats([
      conv('a', them(from)), conv('b', them(to)), conv('c', them(from - 1)), conv('d', them(to + 1))
    ], { now: to, days: 7, orgDomain: '', from, to });
    expect(s.received).toBe(2);
    expect(s.conversations).toBe(2);
    expect(s.days).toBe(7);
    expect(s.receivedByDay.map(d => d.count)).toEqual([1, 0, 0, 0, 0, 0, 1]);
  });

  it('keeps one bucket per local day across a daylight-saving change', () => {
    const from = at(2026, 10, 30, 0), to = at(2026, 11, 3, 23);
    const s = computeStats([conv('a', them(at(2026, 11, 1, 1)), them(at(2026, 11, 1, 23)))], { now: to, days: 5, orgDomain: '', from, to });
    expect(s.receivedByDay.map(d => new Date(d.day).getDate())).toEqual([30, 31, 1, 2, 3]);
    expect(s.receivedByDay[2].count).toBe(2); // both on Nov 1, the 25-hour day
  });

  it('starts weeks on Monday at local midnight', () => {
    expect(new Date(startOfWeek(at(2026, 10, 14))).getDay()).toBe(1); // Wed → Mon 12
    expect(new Date(startOfWeek(at(2026, 10, 12, 0))).getDate()).toBe(12);
    expect(new Date(startOfWeek(at(2026, 10, 11, 23))).getDate()).toBe(5); // Sunday belongs to the week before
    const from = at(2026, 10, 1, 0), to = at(2026, 10, 20);
    const s = computeStats([conv('a', me(at(2026, 10, 6)), me(at(2026, 10, 7)), them(at(2026, 10, 13)))], { now: to, days: 20, orgDomain: '', from, to });
    expect(s.sentByWeek.map(w => w.count)).toEqual([0, 2, 0, 0]);
    expect(s.receivedByWeek.map(w => w.count)).toEqual([0, 0, 1, 0]);
    expect(s.activeByWeek.map(w => w.count)).toEqual([0, 1, 1, 0]);
  });
});

describe('response times', () => {
  const now = at(2026, 10, 20);
  it('measures time to first response apart from time between replies', () => {
    const s = computeStats([
      // They started: first answer after 2 h, then a later reply after 30 h.
      conv('a', them(now - 100 * H), me(now - 98 * H), them(now - 60 * H), me(now - 30 * H)),
      // You started: no first-response time, but their reply and yours count as replies.
      conv('b', me(now - 50 * H), them(now - 49 * H), me(now - 46 * H)),
      // They started, nobody answered: unanswered, not a response time.
      conv('c', them(now - 10 * H, 'emma@h.example'))
    ], { now, days: 14, orgDomain: '' });
    expect(s.firstResponseCount).toBe(1);
    expect(s.firstResponseMs).toBe(2 * H);
    expect(s.myResponseCount).toBe(3);
    expect(s.replyDist.map(b => b.count)).toEqual([0, 2, 0, 1, 0]); // 2 h, 3 h, 30 h (upper bounds are exclusive)
    expect(s.waitingOnYou.map(w => w.id)).toEqual(['c']);
    expect(distribution([0, H - 1, H, 5 * DAY]).map(b => b.count)).toEqual([2, 1, 0, 0, 1]);
  });
});

describe('messy data', () => {
  const now = at(2026, 10, 20);
  it('counts a message once when it appears twice, and leaves out messages without a date', () => {
    const s = computeStats([
      conv('mine', me(now - 5 * H, ['deals@axal.vc'], '<m1@x>'), them(now - 4 * H, 'lp@fund.example', '<m2@x>')),
      // The same messages, as the shared mailbox sees them.
      conv('deals', me(now - 5 * H, ['lp@fund.example'], '<m1@x>'), them(now - 4 * H, 'lp@fund.example', '<m2@x>'), them(0, 'x@y.z', '<m3@x>'))
    ], { now, days: 7, orgDomain: 'axal.vc' });
    expect(s.sent).toBe(1);
    expect(s.received).toBe(1);
    expect(s.duplicates).toBe(2);
    expect(s.missingTime).toBe(1);
  });

  it('copes with a sender without an address', () => {
    const s = computeStats([conv('a', them(now - H, ''))], { now, days: 7, orgDomain: '' });
    expect(s.received).toBe(1);
    expect(s.topContacts).toEqual([]);
  });

  it('exports figures without addresses or subjects', () => {
    const s = computeStats([conv('secret-thread', them(now - 3 * H, 'lp@fund.example'), me(now - H, ['lp@fund.example']))], { now, days: 7, orgDomain: '' });
    const csv = statsCsv(s, 'deals@axal.vc');
    expect(csv).toContain('Sent,1');
    expect(csv).toContain('Median time to first response (h),2.00');
    expect(csv.split('\n').filter(l => /^\d{4}-\d\d-\d\d,/.test(l))).toHaveLength(7);
    expect(csv).not.toMatch(/lp@fund|Subject secret/);
  });
});

describe('bulk email log', () => {
  const sentAt = at(2026, 10, 10);
  const rec: CampaignRecord = {
    id: 'c1', at: sentAt, subject: 'Fund II update', from: 'julian@axal.vc', total: 5, held: 1, failed: 1, scheduled: false, stopped: false,
    accepted: [{ email: 'a@x.example', threadId: 't1' }, { email: 'b@x.example', threadId: 't2' }, { email: 'c@x.example', threadId: 't3' }, { email: 'd@x.example', threadId: 't4' }]
  };
  beforeEach(() => localStorage.clear());

  it('reads replies and bounce notices from thread metadata, and leaves the rest unknown', () => {
    const o = campaignOutcome(rec, [
      conv('t1', them(sentAt - DAY, 'a@x.example'), me(sentAt, ['a@x.example']), them(sentAt + H, 'a@x.example')),
      conv('t2', me(sentAt, ['b@x.example']), them(sentAt + 60_000, 'mailer-daemon@googlemail.com', undefined, true)),
      conv('t3', them(sentAt - DAY, 'c@x.example'), me(sentAt, ['c@x.example']))
    ]);
    // t1: a reply after the send (the one before doesn't count); t2: a bounce notice; t3: nothing yet; t4: not read.
    expect(o).toEqual({ replied: 1, bounceNotices: 1, noReplySeen: 1, notInSample: 1 });
  });

  it('keeps the log on this device, newest first, and bounded', () => {
    for (let i = 0; i < 55; i++) saveCampaign({ ...rec, id: 'c' + i, at: sentAt + i });
    const all = loadCampaigns();
    expect(all).toHaveLength(50);
    expect(all[0].id).toBe('c54');
    localStorage.setItem('axal.campaigns.v1', 'not json');
    expect(loadCampaigns()).toEqual([]);
  });
});
