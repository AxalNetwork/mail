import { useCallback, useEffect, useMemo, useState } from 'react';
import { ANALYZABLE, type DocEntry, type DocRecord, type Documents, type Extraction, type Settings } from '../../lib/documents';
import { DriveNotConnected } from '../../providers/gmail/driveAuth';
import { formatSize } from '../../lib/format';
import { errorText } from '../Toast';

interface Props {
  docs: Documents | null;
  /** Open the email a document was saved from (same mailbox only). */
  onOpenSource: (mailbox: string, threadId: string) => void;
}

const TYPE: [string, string, (m: string) => boolean][] = [
  ['pdf', 'PDF', m => m === 'application/pdf'],
  ['doc', 'Documents', m => /word|document|text\//.test(m)],
  ['sheet', 'Spreadsheets', m => /sheet|excel|csv/.test(m)],
  ['slides', 'Presentations', m => /presentation|powerpoint/.test(m)],
  ['image', 'Images', m => m.startsWith('image/')]
];
const FIELD: Record<string, string> = {
  company_name: 'Company', business_model: 'Business model', market_claim: 'Market claim', revenue: 'Revenue', funding_requirement: 'Funding requirement',
  financial_figure: 'Financial figure', investment_term: 'Investment term', key_risk: 'Key risk', date: 'Date'
};
const day = (iso: string | number) => new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

export function DocumentsPage({ docs, onOpenSource }: Props) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [state, setState] = useState<'loading' | 'disconnected' | 'ready' | 'error'>('loading');
  const [err, setErr] = useState('');
  const [list, setList] = useState<{ entries: DocEntry[]; missing: DocRecord[] } | null>(null);
  const [cat, setCat] = useState('');
  const [type, setType] = useState('');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState('');
  const [open, setOpen] = useState<DocEntry | null>(null);

  const fail = (e: unknown) => {
    if (e instanceof DriveNotConnected) { setState('disconnected'); setErr(e.message); } else setErr(errorText(e));
  };
  const load = useCallback(async () => {
    if (!docs) return;
    setErr('');
    try {
      const s = await docs.settings();
      if (!s || !docs.connected) { setState('disconnected'); return; }
      setSettings(s);
      setList(await docs.list());
      setState('ready');
    } catch (e) { fail(e); if (!(e instanceof DriveNotConnected)) setState('error'); }
  }, [docs]);
  useEffect(() => { load(); }, [load]);

  const run = async (label: string, f: () => Promise<unknown>) => {
    setBusy(label); setErr('');
    try { await f(); await load(); } catch (e) { fail(e); } finally { setBusy(''); }
  };

  const shown = useMemo(() => (list?.entries || []).filter(e =>
    (!cat || e.category === cat) &&
    (!type || TYPE.find(t => t[0] === type)![2](e.file.mimeType)) &&
    (!q.trim() || e.file.name.toLowerCase().includes(q.trim().toLowerCase()))
  ).sort((a, b) => b.file.createdTime.localeCompare(a.file.createdTime)), [list, cat, type, q]);

  const page = (body: React.ReactNode) => (
    <section className="admin" aria-label="Documents">
      <div className="page-inner" style={{ gap: 14 }}>
        <div className="page-title">
          <span className="mono-label">Workspace</span>
          <h1>Documents</h1>
          <span className="muted">Files are stored in your Google Drive, in the “Axal VC Mail” folder. Axal VC Mail only sees the files it put there.</span>
        </div>
        {err && <div className="notice warn" role="alert">{err}</div>}
        {body}
      </div>
    </section>
  );

  if (!docs) return page(<div className="card panel"><span className="muted">Documents need Google sign-in and the Axal VC Mail backend.</span></div>);
  if (state === 'loading') return page(<div className="card panel an-loading"><div className="spinner" /> Checking Google Drive…</div>);
  if (state === 'disconnected') {
    return page(
      <div className="card panel" aria-label="Google Drive connection">
        <b style={{ fontSize: 15 }}>Connect Google Drive</b>
        <span className="muted" style={{ fontSize: 13 }}>
          Axal VC Mail asks for access to <b>only the files it creates</b> in your Drive (Google’s “drive.file” permission), not the rest of your Drive.
          It creates an “Axal VC Mail” folder with a sub-folder per category. You can revoke access any time in your Google account.
        </span>
        <div><button className="btn primary sm" disabled={!!busy} onClick={() => run('connect', () => docs.connect())}>{busy === 'connect' ? 'Connecting…' : 'Connect Google Drive'}</button></div>
      </div>
    );
  }
  if (state === 'error' || !settings || !list) return page(<div className="card panel"><button className="btn sm" onClick={load}>Try again</button></div>);

  return page(
    <>
      <div className="card panel" aria-label="Google Drive connection">
        <div className="row-wrap" style={{ alignItems: 'center' }}>
          <span className="pill ok">● Google Drive connected</span>
          <span className="muted" style={{ fontSize: 12.5 }}>{settings.googleEmail} · {list.entries.length} file{list.entries.length === 1 ? '' : 's'}</span>
          <span className="row-wrap" style={{ marginLeft: 'auto' }}>
            <button className="btn ghost sm" onClick={load} disabled={!!busy} aria-label="Refresh">↻</button>
            <button className="btn ghost sm" onClick={() => { docs.disconnect(); setState('disconnected'); }}>Disconnect</button>
          </span>
        </div>
        <span className="faint" style={{ fontSize: 11.5 }}>Lists what is in Drive now; renames, moves and deletions made in Drive show up on refresh.</span>
      </div>

      <div className="row-wrap" style={{ alignItems: 'center' }}>
        <input className="input" type="search" aria-label="Search documents" placeholder="Search by name" value={q} onChange={e => setQ(e.target.value)} style={{ flex: '1 1 220px' }} />
        <select className="input" aria-label="Category" value={cat} onChange={e => setCat(e.target.value)}>
          <option value="">All folders</option>
          {settings.categories.map(c => <option key={c.folderId} value={c.name}>{c.name}</option>)}
        </select>
        <select className="input" aria-label="File type" value={type} onChange={e => setType(e.target.value)}>
          <option value="">All types</option>
          {TYPE.map(t => <option key={t[0]} value={t[0]}>{t[1]}</option>)}
        </select>
        <UploadButton categories={settings.categories} busy={busy === 'upload'} onUpload={(f, c) => run('upload', () => docs.upload(f, f.name, c))} />
        <button className="btn sm" onClick={() => { const n = window.prompt('New folder name'); if (n) run('folder', () => docs.addCategory(n)); }}>New folder</button>
      </div>

      {!shown.length ? (
        <div className="card panel"><span className="faint">{list.entries.length ? 'No documents match.' : 'No documents yet. Upload one, or save an attachment from an email.'}</span></div>
      ) : (
        <div className="card table table-scroll" aria-label="Document list">
          <div className="trow docs head"><span>NAME</span><span>FOLDER</span><span>TYPE</span><span>SIZE</span><span>ADDED</span><span /></div>
          {shown.map(e => (
            <div key={e.file.id} className="trow docs">
              <button className="user-cell link-like" style={{ textAlign: 'left' }} onClick={() => setOpen(e)}>
                <b>{e.file.name}</b>
                <span>{e.file.owners?.[0]?.displayName || ''}{e.record?.source ? ' · from an email' : ''}{e.record?.extraction.status === 'done' ? ' · analyzed' : ''}</span>
              </button>
              <span className="muted">{e.category || 'Elsewhere in Drive'}</span>
              <span className="muted mono" title={e.file.mimeType}>{e.file.mimeType.split('/').pop()!.split('.').pop()!.slice(0, 12)}</span>
              <span className="muted">{e.file.size ? formatSize(Number(e.file.size)) : '—'}</span>
              <span className="muted">{day(e.file.createdTime)}</span>
              <button className="btn ghost sm" onClick={() => setOpen(e)}>Open</button>
            </div>
          ))}
        </div>
      )}

      {!!list.missing.length && (
        <div className="card panel" aria-label="Missing from Drive">
          <b style={{ fontSize: 14 }}>No longer in Google Drive</b>
          <span className="muted" style={{ fontSize: 12.5 }}>These were trashed or deleted in Drive. Restore them from Drive’s trash, or remove them from this list.</span>
          {list.missing.map(r => (
            <div key={r.id} className="an-row as-div">
              <span className="an-row-main"><b>{r.name}</b><span>{r.category}</span></span>
              <button className="btn ghost sm" onClick={() => run('forget', () => docs.forget(r))}>Remove from list</button>
            </div>
          ))}
        </div>
      )}

      {open && (
        <DocumentPanel key={open.file.id} entry={open} docs={docs} categories={settings.categories.map(c => c.name)} onClose={() => setOpen(null)}
          onOpenSource={onOpenSource} onChanged={async () => { await load(); }} onRemoved={() => { setOpen(null); load(); }} />
      )}
    </>
  );
}

function UploadButton({ categories, busy, onUpload }: { categories: { name: string }[]; busy: boolean; onUpload: (f: File, category: string) => void }) {
  const [category, setCategory] = useState(categories.find(c => c.name === 'General Documents')?.name || categories[0]?.name || '');
  return (
    <span className="row-wrap" style={{ alignItems: 'center' }}>
      <select className="input" aria-label="Upload to" value={category} onChange={e => setCategory(e.target.value)}>
        {categories.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
      </select>
      <label className={'btn primary sm' + (busy ? ' disabled' : '')} style={{ cursor: 'pointer' }}>
        {busy ? 'Uploading…' : 'Upload'}
        <input type="file" hidden aria-label="Upload a file" disabled={busy} onChange={e => { const f = e.target.files?.[0]; if (f) onUpload(f, category); e.target.value = ''; }} />
      </label>
    </span>
  );
}

function DocumentPanel({ entry: e, docs, categories, onClose, onOpenSource, onChanged, onRemoved }: {
  entry: DocEntry; docs: Documents; categories: string[]; onClose: () => void; onOpenSource: (mailbox: string, threadId: string) => void;
  onChanged: () => Promise<void>; onRemoved: () => void;
}) {
  const [preview, setPreview] = useState<{ url?: string; text?: string; error?: string } | null>(null);
  const [record, setRecord] = useState(e.record);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const mime = e.file.mimeType;
  // Images and text preview here; PDFs and Office files open in Drive's viewer (signed in, never made public), which the page's security policy allows.
  const previewable = mime.startsWith('image/') || mime.startsWith('text/');

  useEffect(() => () => { if (preview?.url) URL.revokeObjectURL(preview.url); }, [preview]);

  const act = async (label: string, f: () => Promise<void>) => {
    setBusy(label); setErr('');
    try { await f(); } catch (x) { setErr(errorText(x)); } finally { setBusy(''); }
  };
  // Previews are made from the bytes in the browser; nothing is shared or made public.
  const showPreview = () => act('preview', async () => {
    const blob = await docs.download(e);
    // Typed from what Drive says the file is, so an image is shown as an image.
    setPreview(mime.startsWith('text/') ? { text: (await blob.text()).slice(0, 200_000) } : { url: URL.createObjectURL(new Blob([blob], { type: mime })) });
  });
  const download = () => act('download', async () => {
    const url = URL.createObjectURL(await docs.download(e));
    const a = document.createElement('a'); a.href = url; a.download = e.file.name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  });

  const ex = record?.extraction;
  return (
    <div className="card panel" aria-label="Document">
      <div className="row-wrap" style={{ alignItems: 'center' }}>
        <b style={{ fontSize: 15 }}>{e.file.name}</b>
        <span className="pill">{e.category || 'Elsewhere in Drive'}</span>
        <button className="btn ghost sm" style={{ marginLeft: 'auto' }} onClick={onClose}>Close</button>
      </div>
      <span className="muted" style={{ fontSize: 12.5 }}>
        {mime} · {e.file.size ? formatSize(Number(e.file.size)) : 'size unknown'} · added {day(e.file.createdTime)} · owner {e.file.owners?.[0]?.emailAddress || e.file.owners?.[0]?.displayName || 'you'}
      </span>
      {record?.source && (
        <span style={{ fontSize: 12.5 }}>Saved from an email · <button className="link-btn" onClick={() => onOpenSource(record.source!.mailbox, record.source!.threadId)}>Open the conversation</button></span>
      )}
      <div className="row-wrap">
        {previewable && <button className="btn sm" disabled={!!busy} onClick={showPreview}>{busy === 'preview' ? 'Loading…' : 'Preview'}</button>}
        <button className="btn sm" disabled={!!busy} onClick={download}>Download</button>
        {e.file.webViewLink && <a className="btn sm" href={e.file.webViewLink} target="_blank" rel="noopener noreferrer">{previewable ? 'Open in Drive' : 'Preview in Drive'}</a>}
        <button className="btn sm" disabled={!!busy} onClick={() => { const n = window.prompt('Rename to', e.file.name); if (n && n.trim() && n !== e.file.name) act('rename', async () => { await docs.rename(e, n); await onChanged(); }); }}>Rename</button>
        <select className="input sm" aria-label="Move to folder" value="" disabled={!!busy} onChange={x => { const c = x.target.value; if (c) act('move', async () => { await docs.move(e, c); await onChanged(); }); }}>
          <option value="">Move to…</option>
          {categories.filter(c => c !== e.category).map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <button className="btn danger sm" disabled={!!busy} onClick={() => {
          if (window.confirm('Move "' + e.file.name + '" to the trash in your Google Drive? You can restore it from Drive’s trash for 30 days.')) act('delete', async () => { await docs.remove(e); onRemoved(); });
        }}>Delete</button>
      </div>
      {err && <span className="tone-danger" role="alert" style={{ fontSize: 12.5 }}>{err}</span>}
      {preview?.url && <img src={preview.url} alt={e.file.name} style={{ maxWidth: '100%', borderRadius: 8 }} />}
      {preview?.text != null && <pre className="an-record" style={{ maxHeight: 400, overflow: 'auto' }}>{preview.text}</pre>}

      <div style={{ borderTop: '1px solid var(--line-2)', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <b style={{ fontSize: 14 }}>AI extraction</b>
        {ANALYZABLE.includes(mime) ? (
          <>
            <span className="muted" style={{ fontSize: 12.5 }}>Reads this file from your Drive and sends it to the assistant once, when you ask. The file stays in Drive; the results are saved with it.</span>
            <div><button className="btn sm" disabled={!!busy} onClick={() => act('analyze', async () => { setRecord(await docs.analyze({ ...e, record })); })}>
              {busy === 'analyze' ? 'Reading the document…' : ex?.status === 'done' ? 'Analyze again' : 'Analyze document'}
            </button></div>
          </>
        ) : <span className="faint" style={{ fontSize: 12.5 }}>AI extraction supports PDF and plain text (.txt, .csv, .md) files.</span>}
        {ex?.status === 'failed' && <span className="tone-danger" style={{ fontSize: 12.5 }}>Last analysis failed: {(ex.result as { error: string } | null)?.error || 'unknown error'}</span>}
        {ex?.status === 'done' && ex.result && 'items' in ex.result && <ExtractionView x={ex.result} />}
      </div>
    </div>
  );
}

function ExtractionView({ x }: { x: Extraction }) {
  const group = (kind: Extraction['items'][number]['kind']) => x.items.filter(i => i.kind === kind);
  const row = (i: Extraction['items'][number], n: number) => (
    <li key={n}>
      <b>{FIELD[i.field] || i.field}:</b> {i.value}
      {(i.page || i.quote) && (
        <span className="faint" style={{ display: 'block', fontSize: 12 }}>
          {i.page ? 'p. ' + i.page + ' · ' : ''}{i.quote ? '“' + i.quote + '”' : ''}{i.quoteVerified === true ? ' · found in the text' : ''}
        </span>
      )}
    </li>
  );
  const section = (title: string, items: Extraction['items'], italic = false) => !!items.length && (
    <div><span className="mono-label">{title}</span><ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 13, fontStyle: italic ? 'italic' : undefined }}>{items.map(row)}</ul></div>
  );
  return (
    <div aria-label="Extraction" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <p style={{ margin: 0, fontSize: 13 }}>{x.summary}</p>
      {section('STATED IN THE DOCUMENT', group('stated'))}
      {section('CALCULATED FROM STATED FIGURES', group('calculated'))}
      {section('AI INTERPRETATIONS (NOT STATED)', group('interpretation'), true)}
      {!!x.missing.length && <span className="muted" style={{ fontSize: 12.5 }}>Not stated in the document: {x.missing.map(f => FIELD[f] || f).join(', ')}.</span>}
      {x.source === 'pdf' && <span className="faint" style={{ fontSize: 11.5 }}>For PDFs, quotes and page numbers come from the assistant’s reading; check them in the document.</span>}
    </div>
  );
}
