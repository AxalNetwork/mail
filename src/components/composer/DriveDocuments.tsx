import { useEffect, useMemo, useState } from 'react';
import type { DocEntry, Documents } from '../../lib/documents';
import { DriveNotConnected } from '../../providers/gmail/driveAuth';
import { fileExt, formatSize } from '../../lib/format';
import { errorText } from '../Toast';

interface Props {
  docs: Documents;
  /** The chosen file's bytes, to attach to the message. */
  onPick: (file: File) => void;
  onOpenDocuments?: () => void;
}

/**
 * Attach a file from Documents (the member's Google Drive, "Axal VC Mail"
 * folder). The bytes are downloaded with the member's own access and attached
 * to the email; nothing is shared or made public in Drive. Google Docs, Sheets
 * and Slides files are attached as PDF.
 */
export function DriveDocuments({ docs, onPick, onOpenDocuments }: Props) {
  const [entries, setEntries] = useState<DocEntry[] | null>(null);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState('');

  useEffect(() => {
    let live = true;
    docs.list().then(l => live && setEntries(l.entries)).catch(e => live && setErr(e instanceof DriveNotConnected ? 'Connect Google Drive in Documents first.' : errorText(e)));
    return () => { live = false; };
  }, [docs]);

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (entries || []).filter(e => !t || e.file.name.toLowerCase().includes(t) || e.category.toLowerCase().includes(t))
      .sort((a, b) => a.category.localeCompare(b.category) || a.file.name.localeCompare(b.file.name));
  }, [entries, q]);

  const pick = async (e: DocEntry) => {
    setBusy(e.file.id); setErr('');
    try {
      const f = await docs.file(e);
      onPick(new File([f.blob], f.name, { type: f.mime }));
    } catch (x) {
      setErr(errorText(x));
    } finally { setBusy(''); }
  };

  return (
    <div className="popover drive-docs" style={{ bottom: 42, left: 0, width: 420 }} role="dialog" aria-label="Attach from Documents">
      <span className="mono-label">From Documents · your Google Drive</span>
      <input className="input" type="search" placeholder="Search one-pagers, decks, memos…" aria-label="Search documents" value={q} onChange={e => setQ(e.target.value)} autoFocus />
      {err && <span className="tone-warn" style={{ fontSize: 12 }}>{err} {onOpenDocuments && <button className="link-btn" onClick={onOpenDocuments}>Open Documents</button>}</span>}
      {!entries && !err && <span className="faint" style={{ fontSize: 12 }}>Reading Google Drive…</span>}
      {entries && !shown.length && <span className="faint" style={{ fontSize: 12 }}>{entries.length ? 'No document matches.' : 'No documents yet. Upload them in Documents.'}</span>}
      <div className="drive-docs-list">
        {shown.map(e => {
          const native = e.file.mimeType.startsWith('application/vnd.google-apps.');
          return (
            <button key={e.file.id} className="pop-item" disabled={!!busy} onClick={() => pick(e)}>
              <span className="ext-tag">{native ? 'PDF' : fileExt(e.file.name) || 'FILE'}</span>
              <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                <span style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.file.name}</span>
                <span className="muted" style={{ fontSize: 11 }}>
                  {busy === e.file.id ? 'Attaching…' : (e.category || 'Axal VC Mail') + (native ? ' · attached as PDF' : e.file.size ? ' · ' + formatSize(Number(e.file.size)) : '')}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      <span className="faint" style={{ fontSize: 11 }}>The file is attached to this email. Nothing is shared or made public in Drive.</span>
    </div>
  );
}
