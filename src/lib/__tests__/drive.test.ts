// Mocked Google Drive API: these tests exercise our requests and error handling, not a real Drive.
import { Drive } from '../drive';
import { DriveNotConnected } from '../../providers/gmail/driveAuth';

type Call = { method: string; url: URL; body?: unknown };
function mock(handler: (c: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const c = { method: init.method || 'GET', url: new URL(String(input)), body: init.body };
    calls.push(c);
    return handler(c);
  }));
  return calls;
}
const ok = (j: unknown) => new Response(JSON.stringify(j), { status: 200 });
const auth = () => ({ token: vi.fn(async () => 'drive-token'), invalidate: vi.fn() });

afterEach(() => vi.unstubAllGlobals());

describe('Drive client', () => {
  it('finds the app’s folder before creating one, so reconnecting never duplicates it', async () => {
    let exists = false;
    const calls = mock(c => {
      if (c.method === 'GET') return ok({ files: exists ? [{ id: 'root1', name: 'Axal VC Mail' }] : [] });
      exists = true;
      return ok({ id: 'root1', name: 'Axal VC Mail' });
    });
    const d = new Drive(auth());
    expect((await d.folder('Axal VC Mail', 'root')).id).toBe('root1');
    expect((await d.folder('Axal VC Mail', 'root')).id).toBe('root1');
    expect(calls.filter(c => c.method === 'POST')).toHaveLength(1);
    expect(calls[0].url.searchParams.get('q')).toBe("mimeType = 'application/vnd.google-apps.folder' and appProperties has { key='axal' and value='root' } and trashed = false");
    expect(JSON.parse(String(calls[1].body))).toMatchObject({ name: 'Axal VC Mail', mimeType: 'application/vnd.google-apps.folder', appProperties: { axal: 'root' } });
  });

  it('uploads the bytes as multipart, tagged as managed by the app', async () => {
    const calls = mock(() => ok({ id: 'f1', name: 'Deck.pdf', mimeType: 'application/pdf' }));
    await new Drive(auth()).upload(new Blob(['%PDF-1.4'], { type: 'application/pdf' }), 'Deck.pdf', 'decks', { axalSource: 'k' });
    const c = calls[0];
    expect(c.url.href).toMatch(/^https:\/\/www\.googleapis\.com\/upload\/drive\/v3\/files\?uploadType=multipart/);
    const text = await (c.body as Blob).text();
    expect(text).toContain('"parents":["decks"]');
    expect(text).toContain('"appProperties":{"axalDoc":"1","axalSource":"k"}');
    expect(text).toContain('Content-Type: application/pdf\r\n\r\n%PDF-1.4');
  });

  it('treats a missing or trashed file as gone', async () => {
    mock(c => (c.url.pathname.endsWith('/gone') ? new Response('{}', { status: 404 }) : ok({ id: 't', name: 'x', trashed: true })));
    const d = new Drive(auth());
    expect(await d.get('gone')).toBeNull();
    expect(await d.get('trashed')).toBeNull();
  });

  it('asks to reconnect when Google refuses the grant, and retries rate limits', async () => {
    mock(() => new Response(JSON.stringify({ error: { message: 'Request had insufficient authentication scopes.' } }), { status: 403 }));
    await expect(new Drive(auth()).account()).rejects.toBeInstanceOf(DriveNotConnected);

    let n = 0;
    mock(() => (++n < 3 ? new Response('{}', { status: 429 }) : ok({ user: { emailAddress: 'Julian@axal.vc' } })));
    expect(await new Drive(auth()).account()).toBe('julian@axal.vc');
    expect(n).toBe(3);

    // An expired token is refreshed once; a second 401 means the grant is gone.
    const a = auth();
    mock(() => new Response('{}', { status: 401 }));
    await expect(new Drive(a).account()).rejects.toBeInstanceOf(DriveNotConnected);
    expect(a.invalidate).toHaveBeenCalledTimes(1);
  });

  it('moves between folders and trashes rather than deleting', async () => {
    const calls = mock(() => ok({ id: 'f1', name: 'x', parents: ['b'] }));
    const d = new Drive(auth());
    await d.move('f1', ['a'], 'b');
    expect(Object.fromEntries(calls[0].url.searchParams)).toMatchObject({ addParents: 'b', removeParents: 'a' });
    await d.trash('f1');
    expect(calls[1]).toMatchObject({ method: 'PATCH' });
    expect(JSON.parse(String(calls[1].body))).toEqual({ trashed: true });
  });
});
