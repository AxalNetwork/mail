import type { Env } from './env';
import type { User } from './auth';
import { HttpError, json } from './http';
import { analyzeDocument } from './assistant';

/**
 * Documents live entirely in each member's own Google Drive (the browser talks
 * to Drive with the member's drive.file token; folders, the email a file came
 * from and extraction results are kept in Drive too). The Worker's only part is
 * AI extraction: it reads the file the browser sends, returns the result, and
 * stores nothing.
 */

const MAX_ANALYZE_BYTES = 12 * 1024 * 1024;
export const ANALYZABLE = ['application/pdf', 'text/plain', 'text/csv', 'text/markdown'];

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** The request body for analysis can be larger than ordinary JSON, up to the extraction limit. */
async function readAnalyzeBody(req: Request): Promise<{ mimeType?: unknown; data?: unknown; text?: unknown; name?: unknown }> {
  if (!(req.headers.get('Content-Type') || '').includes('application/json')) throw new HttpError(415, 'Expected application/json');
  const len = Number(req.headers.get('Content-Length') || 0);
  if (len > MAX_ANALYZE_BYTES * 1.4) throw new HttpError(413, 'Documents up to 12 MB can be analyzed.');
  const text = await req.text();
  if (text.length > MAX_ANALYZE_BYTES * 1.4) throw new HttpError(413, 'Documents up to 12 MB can be analyzed.');
  try { return JSON.parse(text); } catch { throw new HttpError(400, 'Malformed JSON'); }
}

async function extract(env: Env, user: User, req: Request) {
  const b = await readAnalyzeBody(req);
  const mime = str(b.mimeType, 120);
  if (!ANALYZABLE.includes(mime)) throw new HttpError(415, 'AI extraction supports PDF and plain text (.txt, .csv, .md) files.', 'unsupported_type');
  const input = mime === 'application/pdf'
    ? { kind: 'pdf' as const, data: typeof b.data === 'string' ? b.data : '' }
    : { kind: 'text' as const, text: typeof b.text === 'string' ? b.text : '' };
  if (input.kind === 'pdf' && !/^[A-Za-z0-9+/=]+$/.test(input.data.slice(0, 1000))) throw new HttpError(400, 'data must be the file, base64-encoded');
  if ((input.kind === 'pdf' ? input.data : input.text).length === 0) throw new HttpError(400, 'The document is empty');
  return analyzeDocument(env, user, { name: str(b.name, 300) || 'document', ...input });
}

export async function route(req: Request, env: Env, user: User, url: URL): Promise<Response> {
  if (url.pathname === '/api/documents/extract' && req.method === 'POST') return json({ extraction: await extract(env, user, req) });
  throw new HttpError(404, 'Not found');
}
