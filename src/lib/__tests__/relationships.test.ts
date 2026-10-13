import { activityFor, isStale, suggestContacts } from '../relationships';
import { contactsCsv, type ContactRecord } from '../contactsApi';
import type { ConvMessage, ConversationStat } from '../../types';

const DAY = 86_400_000;
const NOW = new Date(2026, 9, 13, 12).getTime();
const me = (at: number, to: string[]): ConvMessage => ({ from: 'julian@axal.vc', fromName: 'Julian', fromMe: true, to, at, automated: false });
const them = (at: number, from: string, automated = false): ConvMessage => ({ from, fromName: 'Them', fromMe: false, to: [], at, automated });

describe('relationship activity', () => {
  const sample: ConversationStat[] = [
    { id: 'a', subject: 'A', messages: [them(NOW - 40 * DAY, 'x@co.example'), me(NOW - 39 * DAY, ['x@co.example'])] },
    { id: 'b', subject: 'B', messages: [me(NOW - 10 * DAY, ['y@gmail.com', 'z@other.example'])] },
    { id: 'c', subject: 'C', messages: [them(NOW - DAY, 'y@gmail.com')] },
    { id: 'd', subject: 'Digest', messages: [them(NOW - DAY, 'x@co.example', true)] },
    // The same thread twice in the sample counts once.
    { id: 'c', subject: 'C', messages: [them(NOW - 2 * DAY, 'y@gmail.com')] }
  ];

  it('combines every address of the person, ignores bulk mail, and counts plainly', () => {
    const a = activityFor(['X@co.example', 'y@gmail.com'], sample, NOW);
    expect(a.conversations.map(c => c.id)).toEqual(['c', 'b', 'a']);
    expect(a.conversations[0]).toMatchObject({ received: 2, sent: 0 });
    expect(a.lastInteraction).toBe(NOW - DAY);
    expect([a.sent30, a.received30, a.conversations90]).toEqual([1, 2, 3]);
    expect(a.unanswered.map(c => c.id)).toEqual(['c']);
    expect(a.followUpsDue.map(c => c.id)).toEqual(['b', 'a']);
  });

  it('is stale only by the user’s rule, and never when nothing is known', () => {
    const a = activityFor(['x@co.example'], sample, NOW);
    expect(isStale(a, { enabled: true, days: 30 }, NOW)).toBe(true);
    expect(isStale(a, { enabled: true, days: 60 }, NOW)).toBe(false);
    expect(isStale(a, { enabled: false, days: 30 }, NOW)).toBe(false);
    expect(isStale(activityFor(['nobody@x.example'], sample, NOW), { enabled: true, days: 7 }, NOW)).toBe(false);
  });

  it('suggests two-way, external, non-bulk correspondents that are not records yet', () => {
    const s = suggestContacts([
      ...sample,
      { id: 'e', subject: 'Team', messages: [them(NOW, 'priya@axal.vc'), me(NOW, ['priya@axal.vc'])] },
      { id: 'f', subject: 'Robot', messages: [them(NOW, 'no-reply@x.example'), me(NOW, ['no-reply@x.example'])] }
    ], new Set(['y@gmail.com']), 'axal.vc', new Set());
    expect(s).toEqual([{ email: 'x@co.example', name: 'Them', domain: 'co.example', source: { id: 'a', subject: 'A', at: NOW - 39 * DAY }, received: 1, sent: 1 }]);
    expect(suggestContacts(sample, new Set(), 'axal.vc', new Set(['x@co.example'])).map(x => x.email)).toEqual(['y@gmail.com']); // two-way across threads
    // Personal mail providers suggest no organization.
    expect(suggestContacts([{ id: 'g', subject: 'G', messages: [them(NOW, 'a@gmail.com'), me(NOW, ['a@gmail.com'])] }], new Set(), '', new Set())[0].domain).toBe('');
  });
});

describe('contacts CSV', () => {
  const c = { name: 'Maya "MC" Chen', emails: ['a@x.example', 'b@y.example'], title: 'CEO, founder', organization: { id: 1, name: 'Northstar' }, tags: ['AI'], owner: 'julian@axal.vc', website: '', linkedin: '', notes: 'secret' } as ContactRecord;
  it('quotes fields and leaves notes out unless asked', () => {
    expect(contactsCsv([c])).toBe('Name,Emails,Title,Organization,Tags,Owner,Website,LinkedIn\n"Maya ""MC"" Chen",a@x.example; b@y.example,"CEO, founder",Northstar,AI,julian@axal.vc,,\n');
    expect(contactsCsv([c], true)).toContain(',secret\n');
  });
});
