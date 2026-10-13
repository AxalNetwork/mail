import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SnoozeMenu } from '../SnoozeMenu';
import { ThreadReader } from '../ThreadReader';
import type { Thread } from '../../types';

describe('snooze menu', () => {
  it('offers the usual times and a custom one, and reports the time picked', async () => {
    const u = userEvent.setup();
    const onPick = vi.fn();
    render(<SnoozeMenu disabled={false} onPick={onPick} />);
    await u.click(screen.getByRole('button', { name: 'Snooze' }));
    const menu = screen.getByRole('menu', { name: 'Snooze until' });
    expect(within(menu).getByRole('menuitem', { name: /Tomorrow/ })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: /Next week/ })).toBeInTheDocument();
    await u.click(within(menu).getByRole('menuitem', { name: /Tomorrow/ }));
    const picked = onPick.mock.calls[0][0] as number;
    expect(new Date(picked).getHours()).toBe(8);
    expect(picked).toBeGreaterThan(Date.now());
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    await u.click(screen.getByRole('button', { name: 'Snooze' }));
    const input = screen.getByLabelText('Snooze until date and time');
    await u.clear(input);
    await u.type(input, '2020-01-01T09:00');
    expect(within(screen.getByRole('menu')).getByRole('button', { name: 'Snooze' })).toBeDisabled(); // the past isn't allowed
  });

  it('is disabled with an explanation where snooze can’t work', () => {
    render(<SnoozeMenu disabled title="Snooze needs the Axal VC Mail backend" onPick={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Snooze' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Snooze' })).toHaveAttribute('title', 'Snooze needs the Axal VC Mail backend');
  });
});

describe('reader', () => {
  const thread = (o: Partial<Thread> = {}) => ({
    id: 't1', from: 'Maya', org: '', email: 'maya@n.example', time: '09:42', subject: 'Seed round', snippet: '', labels: [], unread: false, starred: false, attachCount: 0,
    messages: [{ id: 'm1', from: 'Maya', email: 'maya@n.example', to: 'me', time: '09:42', text: 'Hi', attachments: [] }], activity: [], linkText: '', ...o
  }) as Thread;
  const props = { loading: false, error: null, canSnooze: true, demoMode: false, onBack: vi.fn(), onReply: vi.fn(), onForward: vi.fn(), onArchive: vi.fn(), onDelete: vi.fn(), onDownload: vi.fn() };

  it('shows Unsnooze and when it comes back for a snoozed conversation', async () => {
    const u = userEvent.setup();
    const onUnsnooze = vi.fn();
    render(<ThreadReader {...props} thread={thread({ snoozedUntil: Date.now() + 86_400_000 })} onSnooze={vi.fn()} onUnsnooze={onUnsnooze} />);
    expect(screen.getByText(/Snoozed until Tomorrow/)).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Unsnooze' }));
    expect(onUnsnooze).toHaveBeenCalled();
  });

  it('snoozes an ordinary conversation', async () => {
    const u = userEvent.setup();
    const onSnooze = vi.fn();
    render(<ThreadReader {...props} thread={thread()} onSnooze={onSnooze} onUnsnooze={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Unsnooze' })).not.toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Snooze' }));
    await u.click(screen.getByRole('menuitem', { name: /Next week/ }));
    expect(onSnooze).toHaveBeenCalledWith(expect.any(Number));
  });
});
