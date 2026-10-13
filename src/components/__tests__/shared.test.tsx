import { render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SharedBar, useSharedPresence } from '../shared/SharedBar';
import { SharedInboxes } from '../shared/SharedInboxes';
import { ConflictError, type ConversationState, type SharedApi, type SharedMailbox } from '../../lib/sharedApi';
import type { MailProvider } from '../../providers/types';
import type { ThreadSummary } from '../../types';

const you = 'julian@axal.vc';
const members = [{ email: you, name: 'Julian Park', canSend: true }, { email: 'priya@axal.vc', name: 'Priya', canSend: false }];
const blank = (threadId: string, o: Partial<ConversationState> = {}): ConversationState => ({
  threadId, status: 'open', assignee: null, version: 0, updatedBy: null, updatedAt: null, lastReplyBy: null, lastReplyAt: null, presence: [], ...o
});

function fakeApi(initial: Record<string, ConversationState> = {}) {
  const db: Record<string, ConversationState> = { ...initial };
  const box: SharedMailbox = {
    mailbox: 'deals@axal.vc', connection: { ok: true, via: 'delegation', error: null, checkedAt: Date.now() - 60_000 }, members, me: { canSend: true },
    sendAs: [{ email: 'deals@axal.vc', name: 'Deals', primary: true }, { email: 'team@axal.vc', name: '', primary: false }], sync: 'live'
  };
  const api: SharedApi = {
    mailboxes: vi.fn(async () => ({ enabled: true, you, mailboxes: [box] })),
    states: vi.fn(async (_m, ids) => Object.fromEntries(ids.map((id: string) => [id, db[id] || blank(id)]))),
    get: vi.fn(async (_m, id) => ({ state: db[id] || blank(id), activity: [{ actor: 'priya@axal.vc', action: 'status' as const, detail: 'pending', at: Date.now() - 120_000 }], you })),
    update: vi.fn(async (_m, id, v, c) => {
      const cur = db[id] || blank(id);
      if (cur.version !== v) throw new ConflictError('Priya changed this conversation a moment ago. Check it and try again.', cur);
      db[id] = { ...cur, ...c, version: cur.version + 1, presence: cur.presence };
      return db[id];
    }),
    presence: vi.fn(async () => {})
  };
  return { api, db, box };
}

describe('shared conversation bar', () => {
  it('claims, then releases, naming the version it saw', async () => {
    const u = userEvent.setup();
    const { api } = fakeApi();
    render(<SharedBar api={api} mailbox="deals@axal.vc" threadId="s1" members={members} />);
    await u.click(await screen.findByRole('button', { name: 'Claim' }));
    expect(api.update).toHaveBeenCalledWith('deals@axal.vc', 's1', 0, { assignee: you });
    expect(await screen.findByText('Assigned to you')).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Release' }));
    expect(api.update).toHaveBeenLastCalledWith('deals@axal.vc', 's1', 1, { assignee: null });
    await u.selectOptions(screen.getByLabelText('Team status'), 'pending');
    expect(api.update).toHaveBeenLastCalledWith('deals@axal.vc', 's1', 2, { status: 'pending' });
    expect(screen.getByText(/Gmail’s read, label and archive state is not changed/)).toBeInTheDocument();
  });

  it('shows the newer state when someone else changed it first', async () => {
    const u = userEvent.setup();
    const { api, db } = fakeApi();
    render(<SharedBar api={api} mailbox="deals@axal.vc" threadId="s1" members={members} />);
    await screen.findByRole('button', { name: 'Claim' });
    db.s1 = blank('s1', { assignee: 'priya@axal.vc', version: 1, updatedBy: 'priya@axal.vc' }); // Priya claimed it meanwhile
    await u.click(screen.getByRole('button', { name: 'Claim' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Priya changed this conversation a moment ago');
    expect(screen.getByText('Assigned to Priya')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Claim' })).not.toBeInTheDocument();
  });

  it('warns that a teammate is replying or already replied, and shows the history', async () => {
    const u = userEvent.setup();
    const { api } = fakeApi({ s1: blank('s1', { version: 3, presence: [{ email: 'priya@axal.vc', state: 'replying' }], lastReplyBy: 'priya@axal.vc', lastReplyAt: Date.now() - 300_000 }) });
    render(<SharedBar api={api} mailbox="deals@axal.vc" threadId="s1" members={members} />);
    expect(await screen.findByRole('status')).toHaveTextContent('Priya is writing a reply right now.');
    expect(screen.getByText(/Priya replied from deals@axal\.vc 5 min ago/)).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'History' }));
    expect(within(screen.getByLabelText('Assignment history')).getByText(/marked it pending/)).toBeInTheDocument();
  });
});

describe('presence', () => {
  it('beats for open conversations, prefers replying, and says gone when one closes', async () => {
    const { api } = fakeApi();
    const { rerender, unmount } = renderHook(({ e }) => useSharedPresence(api, 'deals@axal.vc', e), { initialProps: { e: { s1: 'viewing' } as Record<string, 'viewing' | 'replying'> } });
    expect(api.presence).toHaveBeenLastCalledWith('deals@axal.vc', 's1', 'viewing');
    rerender({ e: { s1: 'replying' } });
    expect(api.presence).toHaveBeenLastCalledWith('deals@axal.vc', 's1', 'replying');
    rerender({ e: { s2: 'viewing' } });
    expect(api.presence).toHaveBeenCalledWith('deals@axal.vc', 's1', 'gone');
    unmount();
    expect(api.presence).toHaveBeenLastCalledWith('deals@axal.vc', 's2', 'gone');
  });

  it('does nothing outside a shared mailbox', () => {
    const { api } = fakeApi();
    renderHook(() => useSharedPresence(api, undefined, { s1: 'viewing' }));
    expect(api.presence).not.toHaveBeenCalled();
  });
});

describe('Shared Inboxes page', () => {
  const t = (id: string, subject: string): ThreadSummary => ({ id, subject, from: 'Ada LP', org: '', email: 'ada@lp.example', time: '09:42', snippet: '', labels: [], unread: false, starred: false, attachCount: 0 });
  const provider = { listThreads: vi.fn(async () => ({ threads: [t('s1', 'Fund II question'), t('s2', 'Deck from Northstar'), t('s3', 'Wire details')] })) } as unknown as MailProvider;

  it('shows each mailbox’s connection, members, permissions and send-as addresses', async () => {
    const { api } = fakeApi();
    render(<SharedInboxes api={api} providerFor={() => provider} onOpen={vi.fn()} />);
    const card = await screen.findByLabelText('deals@axal.vc');
    expect(within(card).getByText('● Connected')).toBeInTheDocument();
    expect(within(card).getByText('You can read and send')).toBeInTheDocument();
    expect(within(card).getByText(/domain-wide delegation · Read live from Gmail \(nothing is copied\), checked 1 min ago/)).toBeInTheDocument();
    expect(within(card).getByText('(read only)')).toBeInTheDocument();
    expect(within(card).getByText('deals@axal.vc, team@axal.vc (alias)')).toBeInTheDocument();
  });

  it('filters by status and owner, claims from the list, and opens a conversation', async () => {
    const u = userEvent.setup();
    const { api } = fakeApi({ s2: blank('s2', { status: 'pending', assignee: 'priya@axal.vc', version: 2 }), s3: blank('s3', { status: 'resolved', assignee: you, version: 1 }) });
    const onOpen = vi.fn();
    render(<SharedInboxes api={api} providerFor={() => provider} onOpen={onOpen} />);
    const list = await screen.findByLabelText('Conversations in deals@axal.vc');
    await within(list).findByText('Fund II question');
    await u.click(within(list).getByRole('tab', { name: 'Pending 1' }));
    expect(within(list).queryByText('Fund II question')).not.toBeInTheDocument();
    expect(within(list).getByText('Deck from Northstar')).toBeInTheDocument();
    await u.click(within(list).getByRole('tab', { name: 'All' }));
    await u.selectOptions(within(list).getByLabelText('Owner'), 'none');
    expect(within(list).getAllByRole('button', { name: /question|Northstar|Wire/ }).map(b => b.textContent)).toEqual([expect.stringContaining('Fund II question')]);
    await u.click(within(list).getByRole('button', { name: 'Claim' }));
    expect(api.update).toHaveBeenCalledWith('deals@axal.vc', 's1', 0, { assignee: you });
    await waitFor(() => expect(within(list).queryByText('Fund II question')).not.toBeInTheDocument()); // no longer unassigned
    await u.selectOptions(within(list).getByLabelText('Owner'), 'me');
    expect(within(list).getByText('Fund II question')).toBeInTheDocument();
    expect(within(list).getByText('Wire details')).toBeInTheDocument();
    await u.click(within(list).getByText('Wire details'));
    expect(onOpen).toHaveBeenCalledWith('deals@axal.vc', 's3');
  });

  it('explains what is missing when nothing is set up', async () => {
    const api = { mailboxes: async () => ({ enabled: false, you, mailboxes: [] }) } as unknown as SharedApi;
    render(<SharedInboxes api={api} providerFor={() => provider} onOpen={vi.fn()} />);
    expect(await screen.findByText(/Nobody’s personal Google sign-in is shared/)).toBeInTheDocument();
  });
});
