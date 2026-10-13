import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { Composer, type ComposerHandle } from '../composer/Composer';
import { newCompose } from '../composer/state';
import { ToastProvider } from '../Toast';
import { DemoProvider } from '../../providers/demo/DemoProvider';
import { DemoAssistant } from '../../assistant/demo';
import { ApiError } from '../../providers/gmail/client';

async function setup(sendImpl: () => Promise<{ id: string; threadId: string }>) {
  const provider = new DemoProvider();
  const send = vi.spyOn(provider, 'send').mockImplementation(sendImpl as never);
  const [account, identities] = await Promise.all([provider.account(), provider.identities()]);
  const onSent = vi.fn();
  const compose = newCompose({
    fromId: identities[0].id, mode: 'reply', to: [{ name: 'Priya', email: 'priya@axal.vc', org: '' }], subject: 'Re: Fund II', html: '<p>Thanks</p>',
    reply: { threadId: 's1', seenMessageId: 'm1' }
  });
  render(<ToastProvider><Composer compose={compose} update={() => {}} provider={provider} assistant={new DemoAssistant()} account={account} identities={identities}
    handleRef={createRef<ComposerHandle>()} onClosed={vi.fn()} onSent={onSent} onDraftsChanged={vi.fn()} onOpenDraft={vi.fn()} /></ToastProvider>);
  return { send, onSent };
}

const conflict = () => Promise.reject(new ApiError('Priya already replied from deals@axal.vc after you opened this conversation. Send anyway?', 409, 'reply_conflict'));

describe('sending into a shared conversation someone else answered', () => {
  it('asks, and resends with the confirmation when the user agrees', async () => {
    const u = userEvent.setup();
    const ask = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { send, onSent } = await setup(vi.fn().mockImplementationOnce(conflict).mockResolvedValue({ id: 'x', threadId: 's1' }));
    await u.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(onSent).toHaveBeenCalled());
    expect(ask).toHaveBeenCalledWith('Priya already replied from deals@axal.vc after you opened this conversation. Send anyway?');
    expect(send.mock.calls.map(c => c[0].confirmShared)).toEqual([undefined, true]);
  });

  it('does not send when the user declines', async () => {
    const u = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { send, onSent } = await setup(vi.fn().mockImplementation(conflict));
    await u.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText(/Not sent: Priya already replied/)).toBeInTheDocument();
    expect(send).toHaveBeenCalledTimes(1);
    expect(onSent).not.toHaveBeenCalled();
  });
});
