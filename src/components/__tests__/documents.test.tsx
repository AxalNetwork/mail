import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DocumentsPage } from '../documents/DocumentsPage';
import { ThreadReader } from '../ThreadReader';
import { fakeDocuments } from './fakeDocuments';
import type { Thread } from '../../types';

const pdf = () => new Blob(['%PDF-1.4'], { type: 'application/pdf' });

async function connected() {
  const f = fakeDocuments();
  await f.docs.connect();
  await f.docs.upload(pdf(), 'Northstar deck.pdf', 'Pitch Decks');
  await f.docs.upload(new Blob(['memo'], { type: 'text/plain' }), 'IC memo.txt', 'Investment Memoranda');
  return f;
}

describe('Documents page', () => {
  it('explains the narrow Drive permission and connects on request', async () => {
    const u = userEvent.setup();
    const f = fakeDocuments();
    render(<DocumentsPage docs={f.docs} onOpenSource={vi.fn()} />);
    const card = await screen.findByLabelText('Google Drive connection');
    expect(card).toHaveTextContent('only the files it creates');
    await u.click(within(card).getByRole('button', { name: 'Connect Google Drive' }));
    expect(f.auth.connect).toHaveBeenCalled();
    expect(await screen.findByText('● Google Drive connected')).toBeInTheDocument();
  });

  it('lists, filters and searches what is in Drive', async () => {
    const u = userEvent.setup();
    const f = await connected();
    render(<DocumentsPage docs={f.docs} onOpenSource={vi.fn()} />);
    const list = await screen.findByLabelText('Document list');
    expect(within(list).getByText('Northstar deck.pdf')).toBeInTheDocument();
    await u.selectOptions(screen.getByLabelText('Category'), 'Investment Memoranda');
    expect(within(list).queryByText('Northstar deck.pdf')).not.toBeInTheDocument();
    await u.selectOptions(screen.getByLabelText('Category'), '');
    await u.selectOptions(screen.getByLabelText('File type'), 'pdf');
    expect(within(list).queryByText('IC memo.txt')).not.toBeInTheDocument();
    await u.selectOptions(screen.getByLabelText('File type'), '');
    await u.type(screen.getByLabelText('Search documents'), 'memo');
    expect(within(list).getByText('IC memo.txt')).toBeInTheDocument();
    expect(within(list).queryByText('Northstar deck.pdf')).not.toBeInTheDocument();
  });

  it('uploads into the chosen folder', async () => {
    const u = userEvent.setup();
    const f = await connected();
    render(<DocumentsPage docs={f.docs} onOpenSource={vi.fn()} />);
    await screen.findByLabelText('Document list');
    await u.selectOptions(screen.getByLabelText('Upload to'), 'Term Sheets');
    await u.upload(screen.getByLabelText('Upload a file'), new File(['terms'], 'Term sheet.txt', { type: 'text/plain' }));
    expect(await screen.findByText('Term sheet.txt')).toBeInTheDocument();
    expect((await f.docs.list()).entries.find(e => e.file.name === 'Term sheet.txt')).toMatchObject({ category: 'Term Sheets' });
  });

  it('deletes only after confirmation, to Drive’s trash', async () => {
    const u = userEvent.setup();
    const f = await connected();
    render(<DocumentsPage docs={f.docs} onOpenSource={vi.fn()} />);
    await u.click(within(await screen.findByLabelText('Document list')).getByRole('button', { name: /Northstar deck\.pdf/ }));
    const panel = screen.getByLabelText('Document');
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    await u.click(within(panel).getByRole('button', { name: 'Delete' }));
    expect(f.drive.trash).not.toHaveBeenCalled();
    await u.click(within(panel).getByRole('button', { name: 'Delete' }));
    expect(confirm.mock.calls[1][0]).toMatch(/trash in your Google Drive/);
    await waitFor(() => expect(screen.queryByText('Northstar deck.pdf')).not.toBeInTheDocument());
    expect(f.drive.trash).toHaveBeenCalled();
  });

  it('shows extraction results with facts apart from interpretations', async () => {
    const u = userEvent.setup();
    const f = await connected();
    f.extract.mockResolvedValue({
      summary: 'Northstar AI seed deck.', source: 'pdf', missing: ['investment_term'],
      items: [
        { field: 'funding_requirement', value: '$4M seed', kind: 'stated', page: 3, quote: 'raising $4M', quoteVerified: null },
        { field: 'key_risk', value: 'Customer concentration', kind: 'interpretation', page: null, quote: '', quoteVerified: false }
      ]
    });
    render(<DocumentsPage docs={f.docs} onOpenSource={vi.fn()} />);
    await u.click(within(await screen.findByLabelText('Document list')).getByRole('button', { name: /Northstar deck\.pdf/ }));
    await u.click(screen.getByRole('button', { name: 'Analyze document' }));
    const x = await screen.findByLabelText('Extraction');
    expect(within(x).getByText('STATED IN THE DOCUMENT').nextSibling).toHaveTextContent(/Funding requirement: \$4M seed.*p\. 3.*raising \$4M/);
    expect(within(x).getByText('AI INTERPRETATIONS (NOT STATED)').nextSibling).toHaveTextContent('Customer concentration');
    expect(x).toHaveTextContent('Not stated in the document: Investment term.');
  });

  it('asks to reconnect when Drive access was revoked', async () => {
    const f = await connected();
    f.drive.revoked = true;
    render(<DocumentsPage docs={f.docs} onOpenSource={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Reconnect Google Drive');
    expect(screen.getByRole('button', { name: 'Connect Google Drive' })).toBeInTheDocument();
  });

  it('opens the email a document came from', async () => {
    const u = userEvent.setup();
    const f = fakeDocuments();
    await f.docs.connect();
    await f.docs.saveAttachment({ mailbox: 'julian@axal.vc', threadId: 't7', messageId: 'm7', name: 'Deck.pdf', size: 8, mime: 'application/pdf', blob: async () => pdf() }, 'Pitch Decks');
    const onOpenSource = vi.fn();
    render(<DocumentsPage docs={f.docs} onOpenSource={onOpenSource} />);
    await u.click(within(await screen.findByLabelText('Document list')).getByRole('button', { name: /Deck\.pdf/ }));
    await u.click(screen.getByRole('button', { name: 'Open the conversation' }));
    expect(onOpenSource).toHaveBeenCalledWith('julian@axal.vc', 't7');
  });
});

describe('reader attachments', () => {
  const thread = {
    id: 't1', from: 'Maya', org: '', email: 'maya@n.example', time: '', subject: 'Deck', snippet: '', labels: [], unread: false, starred: false, attachCount: 1, activity: [], linkText: '',
    messages: [{ id: 'm1', from: 'Maya', email: 'maya@n.example', to: '', time: '', text: 'Attached.', attachments: [
      { name: 'Deck.pdf', ext: 'PDF', size: 2048, mime: 'application/pdf', messageId: 'm1', attachmentId: 'a1' },
      { name: 'Model.xlsx', ext: 'XLSX', size: 4096, mime: 'application/vnd.ms-excel', messageId: 'm1', attachmentId: 'a2' }
    ] }]
  } as unknown as Thread;
  const base = { loading: false, error: null, canSnooze: false, demoMode: false, onBack: vi.fn(), onReply: vi.fn(), onForward: vi.fn(), onArchive: vi.fn(), onDelete: vi.fn(), onDownload: vi.fn(), onSnooze: vi.fn() };

  it('saves an attachment to a chosen folder, and marks what is already saved', async () => {
    const u = userEvent.setup();
    const onSave = vi.fn();
    const onOpen = vi.fn();
    render(<ThreadReader {...base} thread={thread} documents={{ categories: ['Pitch Decks', 'Due Diligence'], saved: new Set(['m1|Model.xlsx']), busy: null, onSave, onOpen }} />);
    await u.click(screen.getByRole('button', { name: 'Save Deck.pdf to Documents' }));
    await u.click(screen.getByRole('menuitem', { name: 'Pitch Decks' }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ name: 'Deck.pdf', attachmentId: 'a1' }), 'Pitch Decks');
    await u.click(screen.getByRole('button', { name: 'Saved ✓' }));
    expect(onOpen).toHaveBeenCalled();
  });

  it('offers nothing when Documents isn’t connected', () => {
    render(<ThreadReader {...base} thread={thread} documents={null} />);
    expect(screen.queryByRole('button', { name: /to Documents/ })).not.toBeInTheDocument();
  });
});

describe('attaching from Documents in the composer', () => {
  it('lists Drive documents and attaches the real file', async () => {
    const { createRef } = await import('react');
    const { Composer } = await import('../composer/Composer');
    const { newCompose } = await import('../composer/state');
    const { ToastProvider } = await import('../Toast');
    const { DemoProvider } = await import('../../providers/demo/DemoProvider');
    const { DemoAssistant } = await import('../../assistant/demo');
    const u = userEvent.setup();
    const f = fakeDocuments();
    await f.docs.connect();
    await f.docs.upload(new Blob(['%PDF one-pager'], { type: 'application/pdf' }), 'Axal one-pager.pdf', 'One-pagers');
    const provider = new DemoProvider();
    const [account, identities] = await Promise.all([provider.account(), provider.identities()]);
    const update = vi.fn();
    const compose = newCompose({ fromId: identities[0].id, mode: 'new', to: [], subject: '', html: '' });
    render(<ToastProvider><Composer compose={compose} update={update} provider={provider} assistant={new DemoAssistant()} account={account} identities={identities}
      handleRef={createRef()} onClosed={vi.fn()} onSent={vi.fn()} onDraftsChanged={vi.fn()} onOpenDraft={vi.fn()} documents={f.docs} /></ToastProvider>);
    await u.click(screen.getByRole('button', { name: '▤ Document' }));
    const picker = await screen.findByRole('dialog', { name: 'Attach from Documents' });
    await u.type(within(picker).getByLabelText('Search documents'), 'one-pager');
    await u.click(await within(picker).findByRole('button', { name: /Axal one-pager\.pdf/ }));
    await waitFor(() => expect(update).toHaveBeenCalled());
    const patch = update.mock.calls.map(c => c[0]).find(p => typeof p === 'function');
    const next = patch({ ...compose, attachments: [] });
    expect(next.attachments[0]).toMatchObject({ name: 'Axal one-pager.pdf', mime: 'application/pdf', source: { kind: 'file' } });
    expect(await (next.attachments[0].source.blob as Blob).text()).toBe('%PDF one-pager');
  });
});
