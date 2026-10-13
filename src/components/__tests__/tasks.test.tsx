import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { TasksPage } from '../tasks/TasksPage';
import { CreateTaskDialog } from '../tasks/CreateTaskDialog';
import { Composer, type ComposerHandle } from '../composer/Composer';
import { newCompose } from '../composer/state';
import { ToastProvider } from '../Toast';
import { DemoProvider } from '../../providers/demo/DemoProvider';
import { DemoAssistant } from '../../assistant/demo';
import { fakeTasks } from './fakeTasks';
import type { Thread } from '../../types';

async function page(f: ReturnType<typeof fakeTasks>, role: 'super_admin' | 'member' | 'admin' = 'super_admin', onOpenSource = vi.fn()) {
  const provider = new DemoProvider();
  const account = await provider.account();
  render(<TasksPage api={f.api} role={role} provider={provider} profile={account.profile} canSuggest pendingSequences={async () => 2}
    onOpenSequences={vi.fn()} onOpenSource={onOpenSource} onSeen={vi.fn()} />);
  return { provider };
}

const thread = { id: 't1', subject: 'Seed round', labels: [], messages: [{ id: 'm1', from: 'Maya Chen', email: 'maya@n.example', to: 'Julian', time: 'Today', text: 'Can we talk Tuesday?', attachments: [] }] } as unknown as Thread;

describe('Tasks & Approvals', () => {
  afterEach(() => vi.restoreAllMocks());

  it('lets a super admin create, assign and filter tasks', async () => {
    const u = userEvent.setup();
    const f = fakeTasks();
    f.mk({ title: 'Overdue memo', dueAt: Date.now() - 86_400_000, priority: 'urgent' });
    await page(f);
    const list = await screen.findByLabelText('Task list');
    expect(within(list).getByText('Overdue memo')).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'New task' }));
    const dialog = await screen.findByRole('dialog');
    await u.type(within(dialog).getByLabelText('Title'), 'Send the deck');
    await u.selectOptions(within(dialog).getByLabelText('Assignee'), 'julian@axal.vc');
    await u.click(within(dialog).getByRole('button', { name: 'Create task' }));
    await waitFor(() => expect(f.api.create).toHaveBeenCalledWith(expect.objectContaining({ title: 'Send the deck', assignee: 'julian@axal.vc' })));
    expect(await within(screen.getByLabelText('Task list')).findByText('Send the deck')).toBeInTheDocument();
    // Filters.
    await u.selectOptions(screen.getByLabelText('Due'), 'overdue');
    expect(within(screen.getByLabelText('Task list')).queryByText('Send the deck')).not.toBeInTheDocument();
    await u.selectOptions(screen.getByLabelText('Due'), '');
    await u.selectOptions(screen.getByLabelText('Assignee'), 'julian@axal.vc');
    expect(within(screen.getByLabelText('Task list')).queryByText('Overdue memo')).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'GitHub issues' })).toBeInTheDocument();
  });

  it('shows members only their tasks, and only status changes', async () => {
    const u = userEvent.setup();
    const f = fakeTasks('julian@axal.vc', 'member');
    f.mk({ title: 'For Julian', assignee: 'julian@axal.vc', sourceThreadId: 't1', sourceMailbox: 'julian@axal.vc', sourceSubject: 'Seed round' });
    f.mk({ title: 'For Ada', assignee: 'ada@axal.vc' });
    const open = vi.fn();
    await page(f, 'member', open);
    const list = await screen.findByLabelText('Task list');
    expect(within(list).getByText('For Julian')).toBeInTheDocument();
    expect(within(list).queryByText('For Ada')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New task' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'GitHub issues' })).not.toBeInTheDocument();
    await u.click(within(list).getByText('For Julian'));
    const panel = await screen.findByLabelText('Task');
    expect(within(panel).queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    await u.click(within(panel).getByRole('button', { name: 'Open the email' }));
    expect(open).toHaveBeenCalledWith('julian@axal.vc', 't1');
    await u.click(within(panel).getByRole('button', { name: 'Mark completed' }));
    await waitFor(() => expect(f.api.update).toHaveBeenCalledWith(1, 1, { status: 'completed' }));
  });

  it('asks before opening an issue in a public repository', async () => {
    const u = userEvent.setup();
    const f = fakeTasks();
    f.mk({ title: 'Pricing bug' });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    await page(f);
    await u.click(within(await screen.findByLabelText('Task list')).getByText('Pricing bug'));
    const panel = await screen.findByLabelText('Task');
    await waitFor(() => expect(within(panel).getByLabelText('Repository')).toBeInTheDocument());
    // An unreachable repository isn't offered.
    expect(within(within(panel).getByLabelText('Repository')).queryByText(/DeFiScoring/)).not.toBeInTheDocument();
    await u.selectOptions(within(panel).getByLabelText('Repository'), 'AlgoSize/platform');
    expect(within(panel).getByText(/is public/)).toBeInTheDocument();
    await u.click(within(panel).getByRole('button', { name: 'Open an issue' }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('PUBLIC'));
    expect(f.api.openIssue).not.toHaveBeenCalled();
    await u.click(within(panel).getByRole('button', { name: 'Open an issue' }));
    await waitFor(() => expect(f.api.openIssue).toHaveBeenCalledWith(1, 'AlgoSize/platform', true, true));
    expect(await within(panel).findByRole('link', { name: 'AlgoSize/platform#99' })).toBeInTheDocument();
  });

  it('lists GitHub issues across repositories and tracks one', async () => {
    const u = userEvent.setup();
    const f = fakeTasks();
    await page(f);
    await u.click(await screen.findByRole('tab', { name: 'GitHub issues' }));
    const list = await screen.findByLabelText('GitHub issues');
    expect(within(list).getByText('Tasks & Approvals')).toBeInTheDocument();
    expect(screen.getByText(/can’t be read: DeFiScoring\/website/)).toBeInTheDocument();
    await u.click(within(list).getByRole('button', { name: 'Track as task' }));
    await waitFor(() => expect(f.api.track).toHaveBeenCalledWith('AxalNetwork/mail', 2));
    expect(await within(list).findByRole('button', { name: 'Open task' })).toBeInTheDocument();
  });

  it('approves, and sends exactly the approved version', async () => {
    const u = userEvent.setup();
    const f = fakeTasks();
    const ids = await new DemoProvider().identities();
    const a = f.addApproval({}, { identity: { id: ids[0].id, addr: ids[0].addr, name: ids[0].name } });
    const send = vi.spyOn(DemoProvider.prototype, 'send');
    await page(f);
    await u.click(await screen.findByRole('tab', { name: 'Approvals' }));
    expect(await screen.findByRole('button', { name: 'Review sequences' })).toBeInTheDocument();
    await u.click(await screen.findByText('Fee question'));
    const panel = await screen.findByLabelText('Approval request');
    expect(within(panel).getByText('Hello from the approved version')).toBeInTheDocument();
    // Rejecting needs a reason.
    await u.click(within(panel).getByRole('button', { name: 'Reject' }));
    expect(within(panel).getByRole('alert')).toHaveTextContent('Say why');
    await u.click(within(panel).getByRole('button', { name: 'Approve version 1' }));
    await waitFor(() => expect(f.api.decide).toHaveBeenCalledWith(expect.objectContaining({ id: a.id }), 'approve', ''));
    // The requester sends it later: make this viewer the requester.
    Object.assign(f.approvals[0], { requester: 'boss@axal.vc', canExecute: true });
    await u.click(screen.getByRole('tab', { name: 'History' }));
    await u.click(await screen.findByText('Fee question'));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await u.click(await screen.findByRole('button', { name: 'Send as approved' }));
    await waitFor(() => expect(f.api.finish).toHaveBeenCalledWith(a.id, true, '1 sent'));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ subject: 'Fee question', text: 'Hello from the approved version' }));
  });

  it('suggests tasks from an email but creates only the ones ticked', async () => {
    const u = userEvent.setup();
    const f = fakeTasks();
    const onCreated = vi.fn();
    render(<CreateTaskDialog api={f.api} thread={thread} mailbox="boss@axal.vc" canSuggest onCreated={onCreated} onClose={vi.fn()} />);
    await u.click(await screen.findByRole('button', { name: /Suggest tasks/ }));
    expect(await screen.findByText(/They are not commitments/)).toBeInTheDocument();
    expect(screen.getByText(/not found word for word/)).toBeInTheDocument();
    expect(f.api.create).not.toHaveBeenCalled();
    await u.click(screen.getAllByRole('checkbox')[0]);
    await u.click(screen.getByRole('button', { name: 'Create 1 task' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(f.api.create).toHaveBeenCalledTimes(1);
    expect(f.api.create).toHaveBeenCalledWith(expect.objectContaining({ title: 'Send the data room link', createdVia: 'ai_suggested', sourceThreadId: 't1' }));
  });

  it('sends a composed message for approval instead of sending it', async () => {
    const u = userEvent.setup();
    const provider = new DemoProvider();
    Object.defineProperty(provider, 'capabilities', { value: { ...provider.capabilities, demo: false } });
    const send = vi.spyOn(provider, 'send');
    const [account, identities] = await Promise.all([provider.account(), provider.identities()]);
    const ask = vi.fn(async () => {});
    const onClosed = vi.fn();
    const compose = newCompose({ fromId: identities[0].id, mode: 'new', to: [{ name: 'LP', email: 'lp@x.example', org: '' }], subject: 'Fund II', html: '<p>Hi</p>' });
    render(<ToastProvider><Composer compose={compose} update={() => {}} provider={provider} assistant={new DemoAssistant()} account={account} identities={identities}
      handleRef={createRef<ComposerHandle>()} onClosed={onClosed} onSent={vi.fn()} onDraftsChanged={vi.fn()} onOpenDraft={vi.fn()} onRequestApproval={ask} /></ToastProvider>);
    await u.click(screen.getByRole('button', { name: 'Ask for approval' }));
    await waitFor(() => expect(onClosed).toHaveBeenCalled());
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ subject: 'Fund II' }));
    expect(send).not.toHaveBeenCalled();
  });
});
