import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Sequences } from '../automations/Sequences';
import { ToastProvider } from '../Toast';
import { parseRecipients, type Sequence, type SequenceInput, type SequencesApi } from '../../lib/sequencesApi';
import { parseCSV } from '../../lib/csv';
import type { Profile } from '../../types';

const profile: Profile = { id: 'julian@axal.vc', first: 'Julian', last: 'Park', title: 'Managing Partner', region: '', email: 'julian@axal.vc', whatsapp: '', linkedin: '', photo: false };

function fakeApi(over: Partial<SequencesApi> = {}) {
  let stored: Sequence | null = null;
  const calls: string[] = [];
  const toSeq = (i: SequenceInput, patch: Partial<Sequence> = {}): Sequence => ({
    id: 1, name: i.name, owner: 'julian@axal.vc', status: 'draft', version: 1, mine: true, canApprove: true, approved: null, lastError: null,
    createdAt: 0, updatedAt: 0, signatureHtml: i.signatureHtml, steps: i.steps,
    recipients: i.recipients.map((r, k) => ({ ...r, id: k + 1, status: 'pending', nextStep: 0, nextAt: null, lastError: null, firstSentAt: null })), ...patch
  });
  const api: SequencesApi = {
    sender: async () => ({ connected: true, via: 'grant', googleEmail: 'julian@axal.vc', canConnect: true, missing: [] }),
    connect: async () => { throw new Error('unused'); },
    disconnect: async () => ({ connected: false, via: null, googleEmail: null, canConnect: true, missing: [] }),
    list: async () => (stored ? [{ id: 1, name: stored.name, owner: stored.owner, status: stored.status, version: stored.version, mine: true, approved: !!stored.approved, updatedAt: 0, lastError: null, counts: { pending: stored.recipients.length } }] : []),
    get: async () => stored!,
    create: async i => { calls.push('create'); stored = toSeq(i); return stored; },
    update: async (_id, i) => { calls.push('update'); stored = toSeq(i, { version: 2 }); return stored; },
    approve: async (_id, v) => { calls.push('approve:' + v); stored = { ...stored!, status: 'approved', approved: { by: 'julian@axal.vc', at: 1 } }; return stored; },
    action: async (_id, a) => { calls.push(a); stored = { ...stored!, status: a === 'start' ? 'active' : stored!.status }; return stored; },
    stopRecipient: async () => stored!,
    ...over
  };
  return { api, calls, get stored() { return stored; } };
}

describe('outreach sequences page', () => {
  it('creates a sequence, approves the exact version, then starts it', async () => {
    const f = fakeApi();
    const u = userEvent.setup();
    render(<ToastProvider><Sequences api={f.api} profile={profile} onBack={() => {}} /></ToastProvider>);
    await screen.findByText(/Sends as/);
    await u.click(screen.getByRole('button', { name: 'New sequence' }));
    await u.type(screen.getByPlaceholderText('Fund II — LP outreach'), 'Fund II LPs');
    const csv = screen.getByDisplayValue(/email,first name/);
    await u.clear(csv);
    await u.type(csv, 'email,first name,company{enter}lena@kestrel.example,Lena,Kestrel');
    expect(screen.getByText(/1 recipient ·/)).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Save for approval' }));
    await waitFor(() => expect(f.calls).toEqual(['create']));
    expect(f.stored!.signatureHtml).toContain('Julian Park');
    expect(f.stored!.steps[1].delayDays).toBe(4);

    const approve = await screen.findByRole('button', { name: 'Approve version 1' });
    expect(approve).toBeDisabled();
    await u.click(screen.getByRole('checkbox'));
    await u.click(approve);
    await u.click(await screen.findByRole('button', { name: 'Start sending' }));
    await waitFor(() => expect(f.calls).toEqual(['create', 'approve:1', 'start']));
    expect(await screen.findByText('Running')).toBeInTheDocument();
  });

  it('explains when the server is not set up for sending', async () => {
    const f = fakeApi({ sender: async () => ({ connected: false, via: null, googleEmail: null, canConnect: false, missing: ['TOKEN_ENCRYPTION_KEY (32 random bytes, base64)'] }) });
    render(<ToastProvider><Sequences api={f.api} profile={profile} onBack={() => {}} /></ToastProvider>);
    expect(await screen.findByText(/needs TOKEN_ENCRYPTION_KEY/)).toBeInTheDocument();
  });

  it('parses pasted recipients with or without a header row', () => {
    expect(parseRecipients(parseCSV('Email,First Name,Company,Notes\nLena@K.example,Lena,Kestrel,"met in May, NYC"'))).toEqual([
      { email: 'lena@k.example', firstName: 'Lena', lastName: '', company: 'Kestrel', context: 'met in May, NYC' }
    ]);
    expect(parseRecipients(parseCSV('a@x.example\nb@y.example')).map(r => r.email)).toEqual(['a@x.example', 'b@y.example']);
  });
});
