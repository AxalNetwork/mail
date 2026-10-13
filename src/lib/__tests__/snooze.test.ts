import { formatUntil, LocalSnoozes, snoozeOptions } from '../snooze';

process.env.TZ = 'America/Toronto';
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const labels = (now: number) => snoozeOptions(now).map(o => [o.label, new Date(o.at).toString().slice(0, 21)]);

describe('snooze times', () => {
  it('offers later today, tomorrow, the weekend and next week on a weekday', () => {
    expect(labels(at(2026, 10, 14, 9, 20))).toEqual([ // Wednesday 9:20
      ['Later today', 'Wed Oct 14 2026 13:00'],
      ['Tomorrow', 'Thu Oct 15 2026 08:00'],
      ['This weekend', 'Sat Oct 17 2026 09:00'],
      ['Next week', 'Mon Oct 19 2026 08:00']
    ]);
  });

  it('drops “later today” in the evening and “this weekend” on the weekend', () => {
    expect(labels(at(2026, 10, 14, 19, 0)).map(x => x[0])).toEqual(['Tomorrow', 'This weekend', 'Next week']);
    expect(labels(at(2026, 10, 17, 10))).toEqual([ // Saturday
      ['Later today', 'Sat Oct 17 2026 13:00'], ['Tomorrow', 'Sun Oct 18 2026 08:00'], ['Next week', 'Mon Oct 19 2026 08:00']
    ]);
    expect(labels(at(2026, 10, 18, 10)).at(-1)).toEqual(['Next week', 'Mon Oct 19 2026 08:00']); // Sunday → tomorrow is Monday
  });

  it('keeps local wall-clock times across the daylight-saving change', () => {
    // Saturday Oct 31 → Monday Nov 2 crosses the end of DST: still 8:00 local.
    expect(new Date(snoozeOptions(at(2026, 10, 31, 10)).find(o => o.key === 'week')!.at).getHours()).toBe(8);
  });

  it('describes the time relative to today', () => {
    const now = at(2026, 10, 14, 9);
    expect(formatUntil(at(2026, 10, 14, 15), now)).toMatch(/^Today, 3:00/);
    expect(formatUntil(at(2026, 10, 15, 8), now)).toMatch(/^Tomorrow, 8:00/);
    expect(formatUntil(at(2026, 10, 19, 8), now)).toMatch(/^Mon, Oct 19, 8:00/);
  });
});

describe('local snooze store', () => {
  beforeEach(() => localStorage.clear());
  it('keeps one snooze per conversation and mailbox', async () => {
    const s = new LocalSnoozes();
    await s.set('a@x', { threadId: 't1', until: 1, labelId: 'L', lastMessageId: 'm' });
    await s.set('a@x', { threadId: 't1', until: 2, labelId: 'L', lastMessageId: 'm' });
    await s.set('b@x', { threadId: 't1', until: 3, labelId: 'L', lastMessageId: 'm' });
    expect((await s.list('a@x')).map(x => x.until)).toEqual([2]);
    await s.clear('a@x', 't1');
    expect(await s.list('a@x')).toEqual([]);
    expect(await s.list('b@x')).toHaveLength(1);
    expect(await s.serverWakes()).toBe(false);
  });
});
