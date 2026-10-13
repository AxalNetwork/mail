import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Automations } from '../automations/Automations';
import type { MailProvider } from '../../providers/types';
import type { Assistant, Classification } from '../../assistant/types';
import { OfflineAssistant } from '../../assistant/offline';
import { DemoAssistant, demoClassify } from '../../assistant/demo';
import { LocalDismissals, type DismissalStore } from '../../lib/automationsApi';
import type { ConvMessage, ThreadSummary } from '../../types';

const H = 3_600_000;
const now = Date.now();
const me = (at: number): ConvMessage => ({ from: 'julian@axal.vc', fromName: 'Julian', fromMe: true, to: ['sofia@atlas.example'], at, automated: false });
const them = (at: number): ConvMessage => ({ from: 'emma@horizon.example', fromName: 'Emma', fromMe: false, to: [], at, automated: false });

const summary = (id: string, subject: string, snippet: string): ThreadSummary => ({
  id, subject, snippet, from: 'Ada LP', org: '', email: 'ada@lp.example', time: '09:42', date: 1000, labels: [], unread: true, starred: false, attachCount: 0
});

function provider(): MailProvider & { applyLabel: ReturnType<typeof vi.fn> } {
  return {
    orgDomain: 'axal.vc',
    conversations: async () => ({
      truncated: false,
      conversations: [
        { id: 'fu1', subject: 'Term sheet questions', messages: [me(now - 100 * H)] },
        { id: 'rp1', subject: 'Intro to Horizon', messages: [them(now - 5 * H)] }
      ]
    }),
    listThreads: async () => ({ threads: [summary('t1', 'Capital call notice', 'Please confirm by Friday.'), summary('t2', 'Weekly digest', 'Unsubscribe here.')] }),
    applyLabel: vi.fn(async () => {})
  } as unknown as MailProvider & { applyLabel: ReturnType<typeof vi.fn> };
}

function assistant(results: Classification[]): Assistant {
  return Object.assign(new DemoAssistant(), {
    classify: vi.fn(async () => results),
    briefing: vi.fn(async () => ({ summary: 'One LP needs an answer.', priorities: [{ id: 't1', why: 'Deadline Friday.' }], commitments: [{ id: 't1', text: 'Confirm by Friday' }] }))
  });
}

const c1: Classification = { id: 't1', category: 'Investor', priority: 'high', urgent: true, needsResponse: true, confidence: 0.82, explanation: 'An LP asks for confirmation.', actionItems: ['Confirm by Friday'] };
const c2: Classification = { id: 't2', category: 'Newsletter', priority: 'low', urgent: false, needsResponse: false, confidence: 0.9, explanation: 'A digest.', actionItems: [] };

function setup(a: Assistant, d: DismissalStore = new LocalDismissals(), p = provider()) {
  const onOpen = vi.fn();
  const onDraftReply = vi.fn();
  render(<Automations provider={p} orgDomain="axal.vc" assistant={a} dismissals={d} onOpen={onOpen} onDraftReply={onDraftReply} onGo={vi.fn()} />);
  return { p, onOpen, onDraftReply };
}

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('inbox manager', () => {
  it('suggests, and changes a label only after the user confirms', async () => {
    const u = userEvent.setup();
    const { p, onDraftReply } = setup(assistant([c1, c2]));
    await u.click(await screen.findByRole('button', { name: 'Suggest labels and priorities' }));
    const list = await screen.findByLabelText('Inbox suggestions');
    expect(within(list).getByText('An LP asks for confirmation.')).toBeInTheDocument();
    expect(within(list).getByText('82% sure')).toBeInTheDocument();
    expect(within(list).getByText('Confirm by Friday')).toBeInTheDocument();
    expect(within(list).getByText('urgent')).toBeInTheDocument();

    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
    await u.click(within(list).getByRole('button', { name: 'Label AI/Investor' }));
    expect(confirm).toHaveBeenCalledWith('Add the Gmail label "AI/Investor" to "Capital call notice"?');
    expect(p.applyLabel).not.toHaveBeenCalled();

    confirm.mockReturnValueOnce(true);
    await u.click(within(list).getByRole('button', { name: 'Label AI/Investor' }));
    expect(p.applyLabel).toHaveBeenCalledWith('t1', 'AI/Investor');
    expect(await within(list).findByText('Labeled AI/Investor')).toBeInTheDocument();

    // A newsletter does not offer a reply draft; the LP's message does.
    expect(within(list).getAllByRole('button', { name: 'Draft reply' })).toHaveLength(1);
    await u.click(within(list).getByRole('button', { name: 'Draft reply' }));
    expect(onDraftReply).toHaveBeenCalledWith('t1');
  });

  it('dismisses a suggestion and does not ask about it again', async () => {
    const u = userEvent.setup();
    const d = new LocalDismissals();
    const a = assistant([c1, c2]);
    setup(a, d);
    await u.click(await screen.findByRole('button', { name: 'Suggest labels and priorities' }));
    const list = await screen.findByLabelText('Inbox suggestions');
    await u.click(within(list).getAllByRole('button', { name: 'Dismiss' })[1]);
    await waitFor(() => expect(within(list).queryByText('A digest.')).not.toBeInTheDocument());
    expect((await d.load()).triage).toEqual(['t2:1000']);
    await u.click(screen.getByRole('button', { name: 'Refresh suggestions' }));
    await waitFor(() => expect(a.classify).toHaveBeenCalledTimes(2));
    expect((a.classify as ReturnType<typeof vi.fn>).mock.calls[1][0].map((i: { id: string }) => i.id)).toEqual(['t1']);
  });

  it('is off without the assistant, and the audit says why', async () => {
    setup(new OfflineAssistant());
    expect(await screen.findByText('Suggestions need the assistant (ANTHROPIC_API_KEY on the Worker).')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Suggest labels and priorities' })).not.toBeInTheDocument();
    const audit = screen.getByLabelText('Automation status');
    expect(within(audit).getByText('Email-to-CRM').parentElement).toHaveTextContent(/Partial.*for you to review/);
    expect(within(audit).getByText('Automatic sending').parentElement).toHaveTextContent(/Off by design/);
  });
});

describe('briefing, follow-ups and replies', () => {
  it('writes a briefing whose items link to their conversations', async () => {
    const u = userEvent.setup();
    const a = assistant([]);
    const { onOpen } = setup(a);
    await u.click(await screen.findByRole('button', { name: 'Write today’s briefing' }));
    const b = await screen.findByLabelText('Briefing');
    expect(within(b).getByText('One LP needs an answer.')).toBeInTheDocument();
    expect(a.briefing).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ id: 't1', snippet: 'Please confirm by Friday.' })]), 1);
    await u.click(within(b).getAllByRole('button', { name: /Capital call notice/ })[0]);
    expect(onOpen).toHaveBeenCalledWith('t1');
  });

  it('gives each follow-up a reason and stores a dismissal keyed to the latest message', async () => {
    const u = userEvent.setup();
    const d = new LocalDismissals();
    setup(assistant([]), d);
    expect(await screen.findByText(/You wrote last, .*; no reply from sofia@atlas.example\./)).toBeInTheDocument();
    expect(screen.getAllByText(/Emma wrote last/).length).toBeGreaterThan(0);
    await u.click(screen.getByRole('button', { name: 'Dismiss Term sheet questions' }));
    await waitFor(() => expect(screen.queryByText('Term sheet questions')).not.toBeInTheDocument());
    expect((await d.load()).follow_up).toEqual(['fu1:' + (now - 100 * H)]);
  });

  it('restores a suggestion when the dismissal cannot be saved', async () => {
    const u = userEvent.setup();
    const d: DismissalStore = { shared: true, load: async () => ({ follow_up: [], reply: [], triage: [] }), dismiss: async () => { throw new Error('offline'); }, restore: async () => {} };
    setup(assistant([]), d);
    await u.click(await screen.findByRole('button', { name: 'Dismiss Term sheet questions' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('offline');
    expect(screen.getByText('Term sheet questions')).toBeInTheDocument();
  });
});

describe('demo classifier', () => {
  it('uses keyword rules and says so', () => {
    const r = demoClassify({ id: 'x', subject: 'Capital call for Fund II', from: 'Ada', email: 'a@lp.example', snippet: 'Could you confirm by Friday?' });
    expect(r).toMatchObject({ category: 'Investor', priority: 'high', needsResponse: true });
    expect(r.explanation).toMatch(/^Demo rule/);
  });
});
