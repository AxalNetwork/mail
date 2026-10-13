import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Analytics } from '../analytics/Analytics';
import type { OutreachStats } from '../analytics/Outreach';
import type { MailProvider } from '../../providers/types';
import type { ConversationStat, ConvMessage } from '../../types';
import type { SharedApi, SharedMailbox } from '../../lib/sharedApi';
import { saveCampaign } from '../../lib/campaignLog';

const H = 3_600_000;
const now = Date.now();
const me = (t: number, to: string, id: string): ConvMessage => ({ id, from: 'julian@axal.vc', fromName: 'Julian', fromMe: true, to: [to], at: t, automated: false });
const them = (t: number, from: string, id: string): ConvMessage => ({ id, from, fromName: from, fromMe: false, to: [], at: t, automated: false });

function provider(convs: ConversationStat[], mailbox?: string) {
  return {
    mailbox, orgDomain: 'axal.vc',
    account: async () => ({ email: 'julian@axal.vc', name: 'Julian' }),
    conversations: vi.fn(async () => ({ conversations: convs, truncated: false }))
  } as unknown as MailProvider & { conversations: ReturnType<typeof vi.fn> };
}

const own = [
  { id: 'o1', subject: 'Fund II', messages: [them(now - 30 * H, 'lp@fund.example', '<a@x>'), me(now - 28 * H, 'lp@fund.example', '<b@x>')] },
  { id: 'bulk1', subject: 'Update', messages: [me(now - 20 * H, 'x@lp.example', '<c@x>'), them(now - 10 * H, 'x@lp.example', '<d@x>')] }
];
// deals@ sees the Fund II exchange too (Julian copied it), plus its own conversation.
const deals = [
  { id: 'd1', subject: 'Fund II', messages: [them(now - 30 * H, 'lp@fund.example', '<a@x>')] },
  { id: 'd2', subject: 'Deck', messages: [them(now - 5 * H, 'founder@startup.example', '<e@x>')] }
];

const box = (mailbox: string, ok = true): SharedMailbox => ({
  mailbox, connection: { ok, via: 'delegation', error: null, checkedAt: now }, me: { canSend: true }, sendAs: [], sync: 'live',
  members: [{ email: 'priya@axal.vc', name: 'Priya', canSend: true }, { email: 'julian@axal.vc', name: 'Julian', canSend: true }]
});

function sharedApi(boxes: SharedMailbox[]): SharedApi {
  return {
    mailboxes: async () => ({ enabled: true, you: 'julian@axal.vc', mailboxes: boxes }),
    states: vi.fn(async (_m, ids: string[]) => Object.fromEntries(ids.map(id => [id, { threadId: id, status: 'open', assignee: null, version: id === 'd1' ? 1 : 0, updatedBy: null, updatedAt: null, lastReplyBy: null, lastReplyAt: null, presence: [] }]))),
    get: vi.fn(), update: vi.fn(), presence: vi.fn(),
    summary: vi.fn(async () => ({
      from: 0, to: 0, byStatus: { open: 3, pending: 1, resolved: 2 }, unassignedTracked: 1,
      workload: [{ email: 'julian@axal.vc', open: 1, pending: 0, resolved: 2, replies: 4, assignmentsTaken: 1 }, { email: 'priya@axal.vc', open: 2, pending: 1, resolved: 0, replies: 1, assignmentsTaken: 2 }]
    }))
  } as unknown as SharedApi;
}

beforeEach(() => localStorage.clear());

describe('Analytics', () => {
  it('reads only the current mailbox by default, and offers only mailboxes the member can open', async () => {
    const p = provider(own);
    const dealsP = provider(deals, 'deals@axal.vc');
    const providerFor = vi.fn(() => dealsP);
    render(<Analytics provider={p} orgDomain="axal.vc" onOpen={vi.fn()} shared={sharedApi([box('deals@axal.vc'), box('broken@axal.vc', false)])} providerFor={providerFor} />);
    expect(await screen.findByText('Sent (outbound)')).toBeInTheDocument();
    const sel = await screen.findByLabelText('Mailbox');
    expect(within(sel).getAllByRole('option').map(o => o.textContent)).toEqual(['julian@axal.vc', 'deals@axal.vc', 'All mailboxes']);
    expect(providerFor).not.toHaveBeenCalled();
    expect(dealsP.conversations).not.toHaveBeenCalled();
  });

  it('combines mailboxes, counting a message seen in both once', async () => {
    const u = userEvent.setup();
    render(<Analytics provider={provider(own)} orgDomain="axal.vc" onOpen={vi.fn()} shared={sharedApi([box('deals@axal.vc')])} providerFor={() => provider(deals, 'deals@axal.vc')} />);
    await u.selectOptions(await screen.findByLabelText('Mailbox'), 'all');
    const table = await screen.findByLabelText('Volume by mailbox');
    expect(within(table).getByText('deals@axal.vc').parentElement).toHaveTextContent(/^deals@axal\.vc2022—$/); // 2 conversations, 0 sent, 2 received, 2 unanswered, no first response
    // Received: lp (once, though in both), x, founder = 3.
    expect(screen.getByText('Received from people (inbound)').nextSibling).toHaveTextContent('3');
    expect(screen.getByText(/seen in more than one place counted once/)).toBeInTheDocument();
  });

  it('validates a custom range and re-reads for it', async () => {
    const u = userEvent.setup();
    const p = provider(own);
    render(<Analytics provider={p} orgDomain="axal.vc" onOpen={vi.fn()} />);
    await screen.findByText('Sent (outbound)');
    await u.click(screen.getByRole('button', { name: 'Custom' }));
    const iso = (t: number) => new Date(t - new Date(t).getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
    const from = screen.getByLabelText('From');
    await u.clear(from); await u.type(from, iso(now - 200 * 24 * H));
    expect(await screen.findByRole('alert')).toHaveTextContent('at most 180 days');
    await u.clear(from); await u.type(from, iso(now - 3 * 24 * H));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    await waitFor(() => expect(p.conversations).toHaveBeenLastCalledWith(5, 300));
    expect(screen.getByText(/Overview ·/)).toBeInTheDocument();
  });

  it('exports the figures on screen as CSV', async () => {
    const u = userEvent.setup();
    let csv = '';
    vi.spyOn(URL, 'createObjectURL').mockImplementation(b => { void (b as Blob).text().then(t => { csv = t; }); return 'blob:x'; });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(<Analytics provider={provider(own)} orgDomain="axal.vc" onOpen={vi.fn()} />);
    await screen.findByText('Sent (outbound)');
    await u.click(screen.getByRole('button', { name: 'Export CSV' }));
    await waitFor(() => expect(csv).toContain('Mailbox,julian@axal.vc'));
    expect(csv).not.toContain('lp@fund.example');
  });

  it('reports outreach as accepted, failed and unknown delivery, with bulk outcomes from thread metadata', async () => {
    const u = userEvent.setup();
    saveCampaign({ id: 'c1', at: now - 20 * H - 1, subject: 'Quarterly update', from: 'julian@axal.vc', total: 3, accepted: [{ email: 'x@lp.example', threadId: 'bulk1' }, { email: 'y@lp.example', threadId: 'gone' }], held: 0, failed: 1, scheduled: false, stopped: false });
    const stats: OutreachStats = {
      from: 0, to: 0, scope: 'mine', delivery: 'unknown',
      totals: { campaignsCreated: 1, awaitingApproval: 1, accepted: 7, failed: 1, unconfirmed: 1, replied: 2, bounced: 1, optedOut: 1, recipientsFailed: 1 },
      sequences: [{ id: 1, name: 'Fund II LPs', owner: 'julian@axal.vc', status: 'active', createdAt: now, awaitingApproval: false, recipients: 5, accepted: 7, failed: 1, unconfirmed: 1,
        byStatus: { pending: 0, active: 1, replied: 2, opted_out: 1, bounced: 1, stopped: 0, completed: 0, failed: 1 } }]
    };
    const load = vi.fn(async () => stats);
    render(<Analytics provider={provider(own)} orgDomain="axal.vc" onOpen={vi.fn()} outreach={load} />);
    await u.click(screen.getByRole('tab', { name: 'Outreach' }));
    expect(await screen.findByText('Accepted by Gmail')).toBeInTheDocument();
    expect(screen.getByText(/Delivery: unknown/)).toBeInTheDocument();
    expect(screen.queryByText(/delivered\b/i)).toHaveTextContent(/nothing here is counted as delivered/);
    expect(screen.queryByText(/open rate/i)).not.toBeInTheDocument();
    expect(load).toHaveBeenCalledWith(expect.any(Number), expect.any(Number));
    const row = (await screen.findByText('Quarterly update')).closest('.trow') as HTMLElement;
    // Tried 3, accepted 2, failed 1, replied 1 (x wrote back), bounced 0, no reply seen 0 (+1 not read).
    await waitFor(() => expect(row).toHaveTextContent(/321100 \(\+1 unknown\)/));
  });

  it('shows team workload alphabetically, only for shared mailboxes the member can open', async () => {
    const u = userEvent.setup();
    const api = sharedApi([box('deals@axal.vc')]);
    render(<Analytics provider={provider(own)} orgDomain="axal.vc" onOpen={vi.fn()} shared={api} providerFor={() => provider(deals, 'deals@axal.vc')} />);
    await u.click(screen.getByRole('tab', { name: 'Team' }));
    const table = await screen.findByLabelText('Workload');
    expect(within(table).getAllByRole('generic').filter(e => e.className === 'user-cell').map(e => e.querySelector('b')!.textContent)).toEqual(['Julian', 'Priya']);
    expect(screen.getByText(/not a performance score/)).toBeInTheDocument();
    expect(api.summary).toHaveBeenCalledWith('deals@axal.vc', expect.any(Number), expect.any(Number));
    // d2 came in from a person and nobody triaged it; d1 has a stored state.
    await waitFor(() => expect(screen.getByText('Not triaged yet').nextSibling).toHaveTextContent('1'));
  });

  it('says what team analytics need when there is no shared mailbox', async () => {
    const u = userEvent.setup();
    render(<Analytics provider={provider(own)} orgDomain="axal.vc" onOpen={vi.fn()} shared={sharedApi([])} providerFor={() => provider([])} />);
    await u.click(screen.getByRole('tab', { name: 'Team' }));
    expect(await screen.findByText(/you don’t have access to one/)).toBeInTheDocument();
  });
});
