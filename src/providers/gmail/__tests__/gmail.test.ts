import { GmailProvider } from '../GmailProvider';
import type { GoogleAuth } from '../auth';
import { toMessage, toSummary, type GmailMessage } from '../parse';
import { base64Url } from '../../../lib/mime';
import type { Identity, OutgoingMessage } from '../../../types';

const b64 = (s: string) => base64Url(new TextEncoder().encode(s));
const h = (name: string, value: string) => ({ name, value });

function fakeAuth(): GoogleAuth {
  return { token: async () => 'tok', invalidate: vi.fn(), loginHint: '' } as unknown as GoogleAuth;
}

type Route = (url: URL, init: RequestInit) => unknown;

function mockFetch(routes: Record<string, Route>) {
  const calls: { method: string; url: URL; body?: string; headers: Record<string, string> }[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method || 'GET';
    calls.push({ method, url, body: init.body as string | undefined, headers: init.headers as Record<string, string> });
    const key = Object.keys(routes).find(k => {
      const [m, path] = k.split(' ');
      return m === method && url.pathname.endsWith(path);
    });
    if (!key) return new Response(JSON.stringify({ error: { message: 'no route ' + method + ' ' + url.pathname } }), { status: 404 });
    return new Response(JSON.stringify(routes[key](url, init) ?? {}), { status: 200 });
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

const baseRoutes: Record<string, Route> = {
  'GET /oauth2/v3/userinfo': () => ({ email: 'julian@axal.vc', given_name: 'Julian', family_name: 'Park', picture: 'https://lh3.example/p.jpg' }),
  'GET /people/me': () => ({ organizations: [{ title: 'Managing Partner', location: 'North America' }], phoneNumbers: [{ value: '+1 212 555 0148', type: 'mobile' }], urls: [{ value: 'https://www.linkedin.com/in/jp' }] }),
  'GET /users/me/labels': () => ({ labels: [{ id: 'INBOX', name: 'INBOX', type: 'system' }, { id: 'Label_1', name: 'Founders', type: 'user' }] })
};

const msg = (id: string, from: string, labels: string[], extra: Partial<GmailMessage> = {}): GmailMessage => ({
  id, threadId: 't1', labelIds: labels, snippet: 'It&#39;s me', internalDate: String(new Date(2026, 9, 9, 9, 42).getTime()),
  payload: { mimeType: 'text/plain', headers: [h('From', from), h('To', 'Julian Park <julian@axal.vc>'), h('Subject', 'Seed round')], body: { data: b64('Hello') } },
  ...extra
});

beforeEach(() => { localStorage.clear(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('Gmail parsing', () => {
  it('reads nested multipart bodies and attachments', () => {
    const m: GmailMessage = {
      id: 'm1', threadId: 't1', internalDate: '0',
      payload: {
        mimeType: 'multipart/mixed', headers: [h('From', '"Maya Chen" <maya@northstar.example>'), h('To', 'a@x.example, "B" <b@x.example>'), h('Message-ID', '<id1@x>')],
        parts: [
          { mimeType: 'multipart/alternative', parts: [
            { mimeType: 'text/plain', body: { data: b64('Plain ✓') } },
            { mimeType: 'text/html', body: { data: b64('<p>Html ✓</p>') } }
          ] },
          { mimeType: 'application/pdf', filename: 'deck.pdf', body: { attachmentId: 'att1', size: 4200 } }
        ]
      }
    };
    const out = toMessage(m);
    expect(out).toMatchObject({ from: 'Maya Chen', email: 'maya@northstar.example', text: 'Plain ✓', html: '<p>Html ✓</p>', messageIdHeader: '<id1@x>', to: 'a@x.example; B' });
    expect(out.recipients!.map(r => r.email)).toEqual(['a@x.example', 'b@x.example']);
    expect(out.attachments).toEqual([{ name: 'deck.pdf', ext: 'PDF', size: 4200, mime: 'application/pdf', messageId: 'm1', attachmentId: 'att1' }]);
  });

  it('summarises threads from the other party and shows recipients for sent mail', () => {
    const now = new Date(2026, 9, 9, 15, 0);
    const labelNames = new Map([['Label_1', 'Founders']]);
    const t = { id: 't1', messages: [msg('a', 'Maya Chen <maya@n.example>', ['INBOX', 'UNREAD', 'Label_1']), msg('b', 'Julian <julian@axal.vc>', ['SENT'])] };
    expect(toSummary(t, { me: 'julian@axal.vc', labelNames, now })).toMatchObject({ from: 'Maya Chen (2)', unread: true, labels: ['Founders'], time: '09:42', snippet: "It's me" });
    const sent = { id: 't2', messages: [msg('c', 'Julian <julian@axal.vc>', ['SENT'])] };
    expect(toSummary(sent, { me: 'julian@axal.vc', labelNames, now })).toMatchObject({ from: 'Julian Park', outgoing: true });
  });
});

describe('GmailProvider', () => {
  it('builds the account profile from userinfo + People and derives the org domain', async () => {
    mockFetch(baseRoutes);
    const g = new GmailProvider(fakeAuth());
    const a = await g.account();
    expect(a.profile).toMatchObject({ first: 'Julian', last: 'Park', title: 'Managing Partner', region: 'North America', whatsapp: '+1 212 555 0148', linkedin: 'linkedin.com/in/jp', photo: true });
    expect(g.orgDomain).toBe('axal.vc');
  });

  it('lists the primary inbox with label + category query and fetches metadata', async () => {
    const calls = mockFetch({
      ...baseRoutes,
      'GET /users/me/threads': () => ({ threads: [{ id: 't1' }], nextPageToken: 'n2' }),
      'GET /users/me/threads/t1': () => ({ id: 't1', messages: [msg('a', 'Maya <maya@n.example>', ['INBOX'])] })
    });
    const page = await new GmailProvider(fakeAuth()).listThreads({ folder: 'inbox', category: 'primary' });
    const list = calls.find(c => c.url.pathname.endsWith('/threads'))!;
    expect(list.url.searchParams.getAll('labelIds')).toEqual(['INBOX']);
    expect(list.url.searchParams.get('q')).toBe('category:primary');
    const meta = calls.find(c => c.url.pathname.endsWith('/threads/t1'))!;
    expect(meta.url.searchParams.get('format')).toBe('metadata');
    expect(page).toMatchObject({ nextPageToken: 'n2', threads: [{ id: 't1', from: 'Maya' }] });
  });

  it('maps send-as addresses to identities, primary first', async () => {
    mockFetch({
      ...baseRoutes,
      'GET /settings/sendAs': () => ({ sendAs: [
        { sendAsEmail: 'investors@axal.vc', displayName: 'Axal VC Investor Relations', verificationStatus: 'accepted' },
        { sendAsEmail: 'julian@axal.vc', displayName: 'Julian Park', isPrimary: true, isDefault: true },
        { sendAsEmail: 'pending@axal.vc', verificationStatus: 'pending' }
      ] })
    });
    const ids = await new GmailProvider(fakeAuth()).identities();
    expect(ids.map(i => [i.addr, i.short])).toEqual([['julian@axal.vc', 'Personal'], ['investors@axal.vc', 'Alias']]);
  });

  const identity: Identity = { id: 'julian@axal.vc', addr: 'julian@axal.vc', name: 'Julian Park', kind: 'Your mailbox', short: 'Personal', note: '' };
  const out: OutgoingMessage = {
    identity, to: [{ name: 'Maya Chen', email: 'maya@n.example', org: '' }], cc: [], bcc: [], subject: 'Re: Seed round', html: '<p>Hi</p>', text: 'Hi',
    attachments: [{ id: 'x', name: 'n.txt', ext: 'TXT', size: 2, mime: 'text/plain', cls: 'Not classified', secure: false, source: { kind: 'file', blob: new Blob(['ok']) } }],
    priority: 'Normal', reply: { threadId: 't1', messageIdHeader: '<id1@x>' }, note: 'Priya joins Thursday'
  };

  it('sends replies as a multipart upload into the thread', async () => {
    const calls = mockFetch({ ...baseRoutes, 'POST /users/me/messages/send': () => ({ id: 'm9', threadId: 't1' }) });
    const r = await new GmailProvider(fakeAuth()).send(out);
    expect(r).toEqual({ id: 'm9', threadId: 't1' });
    const c = calls.find(x => x.url.pathname.endsWith('/messages/send'))!;
    expect(c.url.pathname).toBe('/upload/gmail/v1/users/me/messages/send');
    expect(c.url.searchParams.get('uploadType')).toBe('multipart');
    expect(c.headers['Content-Type']).toMatch(/^multipart\/related; boundary=/);
    expect(c.body).toContain('{"threadId":"t1"}');
    expect(c.body).toContain('Content-Type: message/rfc822');
    expect(c.body).toContain('In-Reply-To: <id1@x>');
    expect(c.body).toContain('filename="n.txt"');
    expect(JSON.parse(localStorage.getItem('axal.notes')!).t1[0].text).toContain('Priya joins Thursday');
  });

  it('creates a draft, updates it in place, then sends the draft', async () => {
    const calls = mockFetch({
      ...baseRoutes,
      'POST /users/me/drafts': () => ({ id: 'd1', message: { threadId: 't1' } }),
      'PUT /users/me/drafts/d1': () => ({ id: 'd1', message: { threadId: 't1' } }),
      'POST /users/me/drafts/send': () => ({ id: 'm10', threadId: 't1' })
    });
    const g = new GmailProvider(fakeAuth());
    expect(await g.saveDraft(out)).toEqual({ draftId: 'd1', threadId: 't1' });
    await g.send({ ...out, draftId: 'd1' });
    const seq = calls.filter(c => c.url.pathname.includes('/drafts')).map(c => c.method + ' ' + c.url.pathname.replace('/upload', ''));
    expect(seq).toEqual(['POST /gmail/v1/users/me/drafts', 'PUT /gmail/v1/users/me/drafts/d1', 'POST /gmail/v1/users/me/drafts/send']);
    expect(calls.find(c => c.url.pathname.endsWith('/drafts/send'))!.body).toBe('{"id":"d1"}');
  });

  it('reopens a draft without our signature and with reply headers', async () => {
    const html = '<div class="axal-body"><p>Draft body</p></div><div class="axal-signature">SIG</div>';
    mockFetch({
      ...baseRoutes,
      'GET /users/me/drafts/d1': () => ({ id: 'd1', message: { id: 'm1', threadId: 't1', payload: {
        mimeType: 'multipart/alternative',
        headers: [h('From', 'Julian Park <julian@axal.vc>'), h('To', 'Maya <maya@n.example>'), h('Subject', 'Re: Seed'), h('In-Reply-To', '<id1@x>'), h('References', '<r@x> <id1@x>'), h('X-Priority', '1')],
        parts: [{ mimeType: 'text/html', body: { data: b64(html) } }]
      } } })
    });
    const d = await new GmailProvider(fakeAuth()).getDraft('d1');
    expect(d).toMatchObject({ html: '<p>Draft body</p>', subject: 'Re: Seed', priority: 'High', identityAddr: 'julian@axal.vc', reply: { threadId: 't1', messageIdHeader: '<id1@x>', references: '<r@x>' } });
    expect(d.to[0].email).toBe('maya@n.example');
  });

  it('retries once with a fresh token after a 401', async () => {
    const auth = fakeAuth();
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => (n++ === 0 ? new Response('{}', { status: 401 }) : new Response(JSON.stringify({ labels: [] }), { status: 200 }))));
    await new GmailProvider(auth).categories();
    expect(auth.invalidate).toHaveBeenCalledOnce();
    expect(n).toBe(2);
  });

  it('refuses to schedule, since the Gmail API cannot', async () => {
    mockFetch(baseRoutes);
    await expect(new GmailProvider(fakeAuth()).send({ ...out, schedule: { label: 'Mon', when: 'Mon 09:00' } })).rejects.toThrow(/Scheduled send/);
  });
});
