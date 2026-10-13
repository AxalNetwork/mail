import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InternalPanel } from '../internal/InternalPanel';
import { InternalPage } from '../internal/InternalPage';
import { mentionedEmails } from '../internal/MentionBox';
import { ToastProvider } from '../Toast';
import type { AddNote, InternalNote, NotesStore } from '../../providers/gmail/notes';

const members = [{ email: 'priya@axal.vc', name: 'Priya Natarajan' }, { email: 'ada@axal.vc', name: 'Ada Lovelace' }];

function store(initial: InternalNote[] = []) {
  let notes = [...initial];
  const added: { text: string; o?: AddNote }[] = [];
  const s: NotesStore = {
    shared: true,
    list: async () => notes,
    add: async (key, text, author, o) => {
      added.push({ text, o });
      const n: InternalNote = { id: notes.length + 10, key, kind: o?.kind || 'note', text, author, authorEmail: 'julian@axal.vc', subject: o?.subject || '', createdAt: Date.now(), updatedAt: null, mentions: [], mine: true, canEdit: true, canDelete: true };
      notes = [...notes, n];
      return n;
    },
    edit: async (id, text) => { notes = notes.map(n => (n.id === id ? { ...n, text, updatedAt: Date.now() } : n)); return notes.find(n => n.id === id)!; },
    remove: async id => { notes = notes.filter(n => n.id !== id); },
    activity: async () => [{ action: 'created', actor: 'Priya Natarajan', target: null, at: Date.now() }],
    members: async () => members,
    inbox: async () => ({ unread: 1, recent: notes, mentions: notes.map(n => ({ ...n, read: false })) }),
    markRead: vi.fn(async () => {})
  };
  return { s, added, get notes() { return notes; } };
}

const theirs: InternalNote = { id: 1, key: '<root@x>', kind: 'comment', text: 'Potential LP', author: 'Priya Natarajan', authorEmail: 'priya@axal.vc', subject: 'Fund II', createdAt: 0, updatedAt: null, mentions: [], mine: false, canEdit: false, canDelete: false };

describe('internal panel', () => {
  it('posts a comment with an @mention picked from the team', async () => {
    const f = store([theirs]);
    const u = userEvent.setup();
    render(<ToastProvider><InternalPanel store={f.s} noteKey="<root@x>" subject="Fund II" authorName="Julian Park" /></ToastProvider>);
    expect(await screen.findByText('Potential LP')).toBeInTheDocument();
    expect(screen.getByText(/team only · never sent/)).toBeInTheDocument();
    // Someone else's comment can't be edited or deleted from here.
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();

    const box = screen.getByLabelText('Internal comment');
    await u.type(box, 'Can you take this @pri');
    await u.click(await screen.findByRole('option', { name: /Priya Natarajan/ }));
    expect(box).toHaveValue('Can you take this @Priya Natarajan ');
    await u.type(box, 'thanks');
    await u.click(screen.getByRole('button', { name: 'Post internally' }));
    await waitFor(() => expect(f.added).toHaveLength(1));
    expect(f.added[0]).toEqual({ text: 'Can you take this @Priya Natarajan thanks', o: { kind: 'comment', subject: 'Fund II', mentions: ['priya@axal.vc'] } });
    expect(await screen.findByText(/thanks/)).toBeInTheDocument();
  });

  it('edits and deletes your own note', async () => {
    const f = store([{ ...theirs, id: 2, text: 'Mine', author: 'Julian Park', mine: true, canEdit: true, canDelete: true }]);
    const u = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<ToastProvider><InternalPanel store={f.s} noteKey="<root@x>" subject="" authorName="Julian Park" /></ToastProvider>);
    await u.click(await screen.findByRole('button', { name: 'Edit' }));
    const edit = screen.getByLabelText('Edit');
    await u.clear(edit);
    await u.type(edit, 'Mine, updated');
    await u.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Mine, updated')).toBeInTheDocument();
    expect(screen.getByText(/edited/)).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(f.notes).toEqual([]));
  });

  it('lists mentions on the Internal page and opens the conversation', async () => {
    const f = store([theirs]);
    const onOpen = vi.fn();
    const u = userEvent.setup();
    render(<ToastProvider><InternalPage store={f.s} onOpen={onOpen} onChanged={() => {}} /></ToastProvider>);
    expect(await screen.findByRole('tab', { name: /Mentions · 1 new/ })).toBeInTheDocument();
    const row = await screen.findByRole('button', { name: /Fund II/ });
    expect(within(row).getByText(/Potential LP/)).toBeInTheDocument();
    await u.click(row);
    expect(f.s.markRead).toHaveBeenCalledWith([1]);
    expect(onOpen).toHaveBeenCalledWith('<root@x>');
  });

  it('only counts mentions still in the text', () => {
    expect(mentionedEmails('Hi @Ada Lovelace', members)).toEqual(['ada@axal.vc']);
    expect(mentionedEmails('Hi Ada', members)).toEqual([]);
  });
});
