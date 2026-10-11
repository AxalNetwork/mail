import { computeStats, duration, insights, median } from '../analytics';
import type { ConversationStat, ConvMessage } from '../../types';

const H = 3_600_000;
const NOW = new Date(2026, 9, 10, 18, 0).getTime();
const me = (at: number, to = ['maya@n.example']): ConvMessage => ({ from: 'julian@axal.vc', fromName: 'Julian', fromMe: true, to, at, automated: false });
const them = (at: number, from = 'maya@n.example', automated = false): ConvMessage => ({ from, fromName: 'Maya Chen', fromMe: false, to: [], at, automated });
const conv = (id: string, ...messages: ConvMessage[]): ConversationStat => ({ id, subject: 'Subject ' + id, messages });

describe('mailbox analytics', () => {
  const convs = [
    // They wrote, you answered 2h later, they answered you 5h later.
    conv('a', them(NOW - 50 * H), me(NOW - 48 * H), them(NOW - 43 * H)),
    // You wrote 5 days ago; no answer → waiting on others.
    conv('b', me(NOW - 120 * H, ['sofia@atlas.example'])),
    // A person wrote, no answer yet → waiting on you.
    conv('c', them(NOW - 6 * H, 'emma@horizon.example')),
    // Newsletter: not counted as received from people, never waiting on you.
    conv('d', them(NOW - 3 * H, 'news@list.example', true)),
    // Internal-only message from you, 1h ago (too recent for the reply rate).
    conv('e', me(NOW - H, ['priya@axal.vc'])),
    // Outside the 7-day window.
    conv('f', them(NOW - 400 * H), me(NOW - 399 * H))
  ];
  const s = computeStats(convs, { now: NOW, days: 7, orgDomain: 'axal.vc' });

  it('counts volume inside the window, people and bulk mail apart', () => {
    expect(s.conversations).toBe(5);
    expect(s.sent).toBe(3);
    expect(s.received).toBe(3);
    expect(s.receivedAutomated).toBe(1);
    expect(s.sentByDay).toHaveLength(7);
    expect(s.sentByDay.reduce((n, d) => n + d.count, 0)).toBe(3);
  });

  it('measures both response times as medians', () => {
    expect(s.myResponseMs).toBe(2 * H);
    expect(s.theirResponseMs).toBe(5 * H);
  });

  it('computes reply rates by the stated definitions', () => {
    // Messages older than a day: a (answered) and b (not) → 50%.
    expect(s.messageReplyBase).toBe(2);
    expect(s.messageReplyRate).toBe(0.5);
    // People written to: maya (wrote back), sofia, priya.
    expect(s.contactsWritten).toBe(3);
    expect(s.contactsReplied).toBe(1);
  });

  it('lists who is waiting on whom', () => {
    expect(s.waitingOnOthers.map(w => w.id)).toEqual(['b']);
    expect(s.waitingOnYou.map(w => w.id)).toEqual(['a', 'c']);
    expect(s.internalShare).toBeCloseTo(1 / 3);
  });

  it('turns the numbers into observations', () => {
    const text = insights(s).join(' ');
    expect(text).toContain('waiting on someone else');
    expect(text).toContain('median response time is 2.0 h');
  });

  it('formats helpers', () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2, 10])).toBe(2.5);
    expect(duration(30 * 60_000)).toBe('30 min');
    expect(duration(72 * H)).toBe('3 days');
  });
});
