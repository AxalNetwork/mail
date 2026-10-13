import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ContactsPage } from '../contacts/ContactsPage';
import { DemoAssistant } from '../../assistant/demo';
import { OfflineAssistant } from '../../assistant/offline';
import type { Assistant, RelationshipBrief } from '../../assistant/types';
import type { MailProvider } from '../../providers/types';
import type { ConvMessage, ConversationStat, Thread } from '../../types';
import { fakeContactsApi } from './fakeContactsApi';
import { saveStaleRule } from '../../lib/relationships';

const DAY = 86_400_000;
const now = Date.now();
const me = (at: number, to: string): ConvMessage => ({ from: 'julian@axal.vc', fromName: 'Julian', fromMe: true, to: [to], at, automated: false });
const them = (at: number, from: string, name = ''): ConvMessage => ({ from, fromName: name, fromMe: false, to: [], at, automated: false });

const sample: ConversationStat[] = [
  { id: 't1', subject: 'Seed round', messages: [them(now - 10 * DAY, 'maya@northstar.ai', 'Maya Chen'), me(now - 9 * DAY, 'maya@northstar.ai'), them(now - 2 * DAY, 'maya@northstar.ai', 'Maya Chen')] },
  { id: 't2', subject: 'Deck feedback', messages: [me(now - 8 * DAY, 'maya.chen@gmail.com')] },
  { id: 't3', subject: 'Board pack', messages: [them(now - 80 * DAY, 'sofia@atlas.example', 'Sofia Laurent'), me(now - 79 * DAY, 'sofia@atlas.example')] },
  // Two-way with someone new → a suggestion. One-way and bulk mail → not.
  { id: 't4', subject: 'Intro to Horizon', messages: [them(now - 5 * DAY, 'emma@horizon.example', 'Emma Rossi'), me(now - 4 * DAY, 'emma@horizon.example')] },
  { id: 't5', subject: 'Cold pitch', messages: [them(now - 3 * DAY, 'pitch@random.example', 'Random Founder')] },
  { id: 't6', subject: 'Newsletter', messages: [{ ...them(now - DAY, 'news@list.example'), automated: true }] },
  { id: 't7', subject: 'Internal', messages: [them(now - DAY, 'priya@axal.vc', 'Priya'), me(now - DAY, 'priya@axal.vc')] }
];

function provider() {
  return {
    orgDomain: 'axal.vc',
    conversations: async () => ({ conversations: sample, truncated: false }),
    getThread: vi.fn(async (id: string) => ({
      id, subject: sample.find(c => c.id === id)!.subject,
      messages: [{ id: 'm1', from: 'Maya Chen', email: 'maya@northstar.ai', to: '', time: '', date: now - DAY, text: 'We are raising 3M. Will you lead?', attachments: [] }]
    } as unknown as Thread))
  } as unknown as MailProvider & { getThread: ReturnType<typeof vi.fn> };
}

function setup(seed: Parameters<typeof fakeContactsApi>[0] = {}, assistant: Assistant = new DemoAssistant()) {
  const f = fakeContactsApi(seed);
  const p = provider();
  const onOpenThread = vi.fn();
  const onDraftReply = vi.fn();
  const onWrite = vi.fn();
  render(<ContactsPage api={f.api} provider={p} assistant={assistant} orgDomain="axal.vc" myEmails={['julian@axal.vc']}
    onOpenThread={onOpenThread} onDraftReply={onDraftReply} onWrite={onWrite} />);
  return { ...f, p, onOpenThread, onDraftReply, onWrite };
}

const maya = { name: 'Maya Chen', emails: ['maya.chen@gmail.com', 'maya@northstar.ai'], title: 'CEO', tags: ['Founder'] };

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('contacts list and records', () => {
  it('creates a contact with several addresses and refuses one that is taken', async () => {
    const u = userEvent.setup();
    const f = setup({ contacts: [{ name: 'Sofia Laurent', emails: ['sofia@atlas.example'] }] });
    await u.click(await screen.findByRole('button', { name: 'New contact' }));
    const form = screen.getByRole('form', { name: 'Contact details' });
    await u.type(within(form).getByLabelText('Name'), 'Maya Chen');
    await u.type(within(form).getByLabelText(/Email addresses/), 'Maya@Northstar.ai, maya.chen@gmail.com');
    await u.type(within(form).getByLabelText(/Tags/), 'Founder, AI');
    await u.click(within(form).getByRole('button', { name: 'Create contact' }));
    expect(f.api.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Maya Chen', emails: ['maya@northstar.ai', 'maya.chen@gmail.com'], tags: ['Founder', 'AI'], owner: '' }));
    expect(await screen.findByRole('heading', { name: 'Maya Chen' })).toBeInTheDocument();

    await u.click(screen.getByRole('button', { name: '← Contacts' }));
    await u.click(await screen.findByRole('button', { name: 'New contact' }));
    const again = screen.getByRole('form', { name: 'Contact details' });
    await u.type(within(again).getByLabelText('Name'), 'S. Laurent');
    await u.type(within(again).getByLabelText(/Email addresses/), 'sofia@atlas.example');
    await u.click(within(again).getByRole('button', { name: 'Create contact' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('sofia@atlas.example already belongs to another contact.');
    await u.click(screen.getByRole('button', { name: 'Open the existing contact' }));
    expect(await screen.findByRole('heading', { name: 'Sofia Laurent' })).toBeInTheDocument();
  });

  it('links a contact to their email history with plain indicators, and drafts a follow-up', async () => {
    const u = userEvent.setup();
    const f = setup({ contacts: [maya] });
    await u.click(await screen.findByRole('button', { name: /Maya Chen/ }));
    const ind = await screen.findByLabelText('Relationship indicators');
    await waitFor(() => expect(within(ind).getByText('2 days ago')).toBeInTheDocument());
    expect(within(ind).getByText('Waiting on you').nextSibling).toHaveTextContent('1');
    expect(within(ind).getByText('Follow-ups due').nextSibling).toHaveTextContent('1'); // t2: you wrote 8 days ago to her other address
    const tl = screen.getByLabelText('Relationship timeline');
    expect(within(tl).getByText('Seed round')).toBeInTheDocument();
    expect(within(tl).getByText('Deck feedback')).toBeInTheDocument();
    expect(within(tl).queryByText('Board pack')).not.toBeInTheDocument();
    await u.click(within(tl).getByText('Seed round'));
    expect(f.onOpenThread).toHaveBeenCalledWith('t1');
    await u.click(screen.getByRole('button', { name: 'Draft follow-up' }));
    expect(f.onDraftReply).toHaveBeenCalledWith('t1');
  });

  it('records an introduction on the timeline', async () => {
    const u = userEvent.setup();
    const f = setup({ contacts: [maya] });
    await u.click(await screen.findByRole('button', { name: /Maya Chen/ }));
    await u.click(await screen.findByRole('button', { name: 'Record an introduction or meeting' }));
    await u.type(screen.getByLabelText('What happened'), 'Introduced by Emma Rossi');
    await u.selectOptions(screen.getByLabelText('Email'), 't1');
    await u.click(screen.getByRole('button', { name: 'Save' }));
    expect(f.api.addEvent).toHaveBeenCalledWith(f.contacts[0].id, expect.objectContaining({ kind: 'introduction', text: 'Introduced by Emma Rossi', threadId: 't1' }));
    const tl = screen.getByLabelText('Relationship timeline');
    expect(await within(tl).findByText('Introduced by Emma Rossi')).toBeInTheDocument();
    expect(screen.getByText('Recorded introductions').nextSibling).toHaveTextContent('1');
  });

  it('flags a possible duplicate and merges it after confirmation', async () => {
    const u = userEvent.setup();
    const f = setup({ contacts: [{ name: 'Maya Chen', emails: ['maya@northstar.ai'] }, { name: 'maya chen', emails: ['maya.chen@gmail.com'] }] });
    await u.click((await screen.findAllByRole('button', { name: /Maya Chen/i }))[0]);
    const dup = await screen.findByLabelText('Possible duplicates');
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    await u.click(within(dup).getByRole('button', { name: 'Merge into this' }));
    expect(f.api.merge).not.toHaveBeenCalled();
    await u.click(within(dup).getByRole('button', { name: 'Merge into this' }));
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(f.api.merge).toHaveBeenCalledWith(f.contacts[0].id, f.contacts[1].id);
    await waitFor(() => expect(screen.queryByLabelText('Possible duplicates')).not.toBeInTheDocument());
  });

  it('exports what is listed as CSV, without notes', async () => {
    const u = userEvent.setup();
    let csv = '';
    vi.spyOn(URL, 'createObjectURL').mockImplementation(b => { void (b as Blob).text().then(t => { csv = t; }); return 'blob:x'; });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    setup({ contacts: [{ ...maya, notes: 'Confidential: raising at 20M' }] });
    await u.click(await screen.findByRole('button', { name: 'Export CSV' }));
    await waitFor(() => expect(csv).toContain('Maya Chen,maya.chen@gmail.com; maya@northstar.ai,CEO'));
    expect(csv).not.toContain('Confidential');
  });
});

describe('suggestions', () => {
  it('suggests only two-way external correspondents, and creates a record after review', async () => {
    const u = userEvent.setup();
    const f = setup({ contacts: [maya], orgs: [{ name: 'Horizon Labs', domain: 'horizon.example' }] });
    await u.click(await screen.findByRole('tab', { name: 'Suggestions' }));
    const list = await screen.findByLabelText('Suggested contacts');
    expect(within(list).getByText('Emma Rossi')).toBeInTheDocument();
    expect(within(list).getByText(/emma@horizon\.example · Horizon Labs/)).toBeInTheDocument();
    for (const t of ['Random Founder', /news@list/, /priya@axal/, /maya@northstar/, /maya\.chen@gmail/]) expect(within(list).queryByText(t)).not.toBeInTheDocument();
    // Sofia wrote and you replied 80 days ago: still in the 90-day window.
    expect(within(list).getByText('sofia@atlas.example', { exact: false })).toBeInTheDocument();

    await u.click(within(list).getAllByRole('button', { name: 'Review and create' })[0]);
    const form = screen.getByRole('form', { name: 'Contact details' });
    expect(within(form).getByText(/Suggested from/)).toHaveTextContent('Intro to Horizon');
    expect(within(form).getByLabelText('Name')).toHaveValue('Emma Rossi');
    expect(within(form).getByLabelText('Organization')).toHaveDisplayValue('Horizon Labs');
    expect(f.api.create).not.toHaveBeenCalled();
    await u.click(within(form).getByRole('button', { name: 'Create contact' }));
    expect(f.api.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Emma Rossi', emails: ['emma@horizon.example'], organizationId: f.orgs[0].id }));
  });

  it('dismisses a suggestion, and can add the address to an existing contact instead', async () => {
    const u = userEvent.setup();
    const f = setup({ contacts: [maya] });
    await u.click(await screen.findByRole('tab', { name: 'Suggestions' }));
    const list = await screen.findByLabelText('Suggested contacts');
    const sofiaRow = within(list).getByText('Sofia Laurent').closest('.an-row') as HTMLElement;
    await u.click(within(sofiaRow).getByRole('button', { name: 'Not a contact' }));
    await waitFor(() => expect(within(list).queryByText('Sofia Laurent')).not.toBeInTheDocument());
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await u.selectOptions(within(list).getByLabelText('Add emma@horizon.example to an existing contact'), String(f.contacts[0].id));
    expect(f.api.update).toHaveBeenCalledWith(f.contacts[0].id, { emails: [...maya.emails, 'emma@horizon.example'] });
  });
});

describe('organizations', () => {
  it('creates an organization, refuses a near-duplicate, and associates contacts', async () => {
    const u = userEvent.setup();
    const f = setup({ contacts: [{ name: 'Sofia Laurent', emails: ['sofia@atlas.example'] }], orgs: [{ name: 'Atlas Systems', domain: 'atlas.example' }] });
    await u.click(await screen.findByRole('tab', { name: 'Organizations' }));
    await u.click(screen.getByRole('button', { name: 'New organization' }));
    await u.type(screen.getByLabelText('Name'), 'atlas  systems');
    await u.click(screen.getByRole('button', { name: 'Create organization' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Atlas Systems already exists.');
    await u.click(screen.getByRole('button', { name: 'Open it' }));
    expect(await screen.findByRole('heading', { name: 'Atlas Systems' })).toBeInTheDocument();
    // Its domain links the conversation even before Sofia is associated.
    expect(await within(screen.getByLabelText('Relationship timeline')).findByText('Board pack')).toBeInTheDocument();
    await u.selectOptions(screen.getByLabelText('Add a contact'), String(f.contacts[0].id));
    await u.click(screen.getByRole('button', { name: 'Add' }));
    expect(f.api.update).toHaveBeenCalledWith(f.contacts[0].id, { organizationId: f.orgs[0].id });
    expect(await within(screen.getByLabelText('People')).findByText('Sofia Laurent')).toBeInTheDocument();
  });
});

describe('relationship AI and indicators', () => {
  const brief: RelationshipBrief = {
    mode: 'summary', summary: 'Maya is raising a seed round.',
    facts: [{ text: 'Raising 3M', sources: ['t1'] }], inferences: [{ text: 'Likely to close soon', sources: [] }],
    openQuestions: [{ text: 'Will you lead?', sources: ['t1'] }], commitments: [], nextSteps: ['Reply about leading']
  };

  it('reads the latest conversations, separates facts from inferences and links sources', async () => {
    const u = userEvent.setup();
    const a = Object.assign(new DemoAssistant(), { relationship: vi.fn(async () => brief) });
    const f = setup({ contacts: [maya] }, a);
    await u.click(await screen.findByRole('button', { name: /Maya Chen/ }));
    await u.click(await screen.findByRole('button', { name: 'Summarize relationship' }));
    const out = await screen.findByLabelText('Relationship summary');
    expect(a.relationship).toHaveBeenCalledWith(f.contacts[0].id, [
      expect.objectContaining({ id: 't1', messages: [expect.objectContaining({ from: 'maya@northstar.ai', fromMe: false, text: 'We are raising 3M. Will you lead?' })] }),
      expect.objectContaining({ id: 't2' })
    ], 'summary');
    expect(within(out).getByText('FACTS FROM YOUR EMAIL AND RECORDS')).toBeInTheDocument();
    expect(within(out).getByText('AI INFERENCES (NOT STATED ANYWHERE)').nextSibling).toHaveTextContent('Likely to close soon');
    await u.click(within(out).getAllByRole('button', { name: 'Seed round' })[0]);
    expect(f.onOpenThread).toHaveBeenCalledWith('t1');
  });

  it('says what it needs without the assistant', async () => {
    const u = userEvent.setup();
    setup({ contacts: [maya] }, new OfflineAssistant());
    await u.click(await screen.findByRole('button', { name: /Maya Chen/ }));
    expect(await screen.findByText(/Summaries and meeting briefings need the assistant/)).toBeInTheDocument();
  });

  it('marks stale relationships by a rule the user sets or turns off', async () => {
    const u = userEvent.setup();
    setup({ contacts: [maya, { name: 'Sofia Laurent', emails: ['sofia@atlas.example'] }] });
    const table = await screen.findByLabelText('Contacts');
    const sofia = () => within(table).getByText('Sofia Laurent').closest('button') as HTMLElement;
    await waitFor(() => expect(within(sofia()).getByText('Stale')).toBeInTheDocument());
    expect(within(within(table).getByText('Maya Chen').closest('button') as HTMLElement).queryByText('Stale')).not.toBeInTheDocument();
    await u.click(screen.getByRole('tab', { name: 'Indicators' }));
    await u.click(screen.getByLabelText('Show the stale indicator'));
    await u.click(screen.getByRole('tab', { name: 'People' }));
    expect(within(sofia()).queryByText('Stale')).not.toBeInTheDocument();
    saveStaleRule({ enabled: true, days: 60 });
  });
});
