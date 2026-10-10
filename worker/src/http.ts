export class HttpError extends Error {
  /** `code` lets the frontend tell cases apart, e.g. not_linked vs suspended. */
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message);
  }
}

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff'
};

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...SECURITY_HEADERS, ...headers }
  });
}

export function errorResponse(e: unknown): Response {
  if (e instanceof HttpError) return json({ error: e.message, ...(e.code ? { code: e.code } : {}) }, e.status);
  console.error('Unhandled error', e);
  return json({ error: 'Internal error' }, 500);
}

const MAX_BODY = 512 * 1024;

/** Parse a JSON body, rejecting oversized or malformed requests. */
export async function readJson<T>(req: Request): Promise<T> {
  if (!(req.headers.get('Content-Type') || '').includes('application/json')) throw new HttpError(415, 'Expected application/json');
  const len = Number(req.headers.get('Content-Length') || 0);
  if (len > MAX_BODY) throw new HttpError(413, 'Request too large');
  const text = await req.text();
  if (text.length > MAX_BODY) throw new HttpError(413, 'Request too large');
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(400, 'Malformed JSON');
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Model output is plain text; HTML is built here so nothing it writes can inject markup. */
export function paragraphsToHtml(paragraphs: string[]): string {
  return paragraphs
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => '<p>' + escapeHtml(p).replace(/\n/g, '<br>') + '</p>')
    .join('');
}
