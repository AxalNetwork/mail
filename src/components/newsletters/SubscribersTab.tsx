import { useCallback, useEffect, useState } from 'react';
import { parseCSV } from '../../lib/csv';
import type { NewslettersApi, NlList, Subscriber } from '../../lib/newslettersApi';
import { errorText } from '../Toast';

interface Props {
  api: NewslettersApi;
  lists: NlList[];
  toast: (text: string, error?: boolean) => void;
}

const STATUS = ['subscribed', 'pending', 'unsubscribed', 'bounced', 'suppressed'] as const;
const FIELDS = ['email', 'firstName', 'lastName', 'company'] as const;
const GUESS: Record<(typeof FIELDS)[number], RegExp> = { email: /e-?mail/i, firstName: /first|given|prénom/i, lastName: /last|family|surname|nom/i, company: /company|org|firm/i };

export function SubscribersTab({ api, lists, toast }: Props) {
  const [q, setQ] = useState({ q: '', status: '', list: '', page: '0' });
  const [data, setData] = useState<{ total: number; subscribers: Subscriber[] } | null>(null);
  const [err, setErr] = useState('');
  const [mode, setMode] = useState<'' | 'add' | 'import'>('');
  const [person, setPerson] = useState({ email: '', firstName: '', lastName: '', company: '' });
  const [listIds, setListIds] = useState<number[]>([]);
  const [attested, setAttested] = useState(false);
  const [csv, setCsv] = useState<{ head: string[]; rows: string[][]; map: Record<string, number> } | null>(null);
  const [open, setOpen] = useState<Subscriber | null>(null);

  const load = useCallback(() => {
    setErr('');
    api.subscribers(Object.fromEntries(Object.entries(q).filter(([, v]) => v))).then(setData).catch(e => setErr(errorText(e)));
  }, [api, q]);
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);

  const listPicker = (
    <div className="row-wrap">
      {lists.map(l => (
        <label key={l.id} className="check-row">
          <input type="checkbox" checked={listIds.includes(l.id)} onChange={e => setListIds(e.target.checked ? [...listIds, l.id] : listIds.filter(x => x !== l.id))} /> {l.name}
        </label>
      ))}
    </div>
  );
  const consent = (
    <label className="check-row">
      <input type="checkbox" checked={attested} onChange={e => setAttested(e.target.checked)} />
      <span>These people agreed to receive Axal VC newsletters. <span className="faint">Unticked: each gets a confirmation email first, and is sent nothing until they confirm.</span></span>
    </label>
  );
  const done = (r: { added: number; updated: number; pendingConfirmation: number; skipped: number; invalid: number }) => {
    toast(`${r.added} added, ${r.updated} updated${r.pendingConfirmation ? `, ${r.pendingConfirmation} asked to confirm` : ''}${r.skipped ? `, ${r.skipped} skipped (unsubscribed or removed)` : ''}${r.invalid ? `, ${r.invalid} invalid` : ''}.`);
    setMode(''); setCsv(null); setAttested(false); load();
  };

  const readFile = async (f: File) => {
    const rows = parseCSV(await f.text()).filter(r => r.some(c => c.trim()));
    if (rows.length < 2) { toast('That file has no rows.', true); return; }
    const head = rows[0];
    const map: Record<string, number> = {};
    for (const k of FIELDS) { const i = head.findIndex(h => GUESS[k].test(h)); if (i >= 0) map[k] = i; }
    setCsv({ head, rows: rows.slice(1), map });
  };

  return (
    <>
      <div className="row-wrap" style={{ alignItems: 'center' }}>
        <input className="input" type="search" placeholder="Search name, email or company" aria-label="Search subscribers" style={{ flex: '1 1 220px' }} value={q.q} onChange={e => setQ({ ...q, q: e.target.value, page: '0' })} />
        <select className="input" aria-label="Status" value={q.status} onChange={e => setQ({ ...q, status: e.target.value, page: '0' })}>
          <option value="">Any status</option>
          {STATUS.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select className="input" aria-label="List" value={q.list} onChange={e => setQ({ ...q, list: e.target.value, page: '0' })}>
          <option value="">All lists</option>
          {lists.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <button className="btn sm" onClick={() => setMode(mode === 'add' ? '' : 'add')}>Add person</button>
        <button className="btn sm" onClick={() => setMode(mode === 'import' ? '' : 'import')}>Import CSV</button>
        <button className="btn ghost sm" onClick={() => api.exportCsv().then(b => {
          const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'subscribers.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        }).catch(e => toast(errorText(e), true))}>Export</button>
      </div>
      {err && <div className="notice warn" role="alert">{err}</div>}

      {mode === 'add' && (
        <div className="card panel">
          <b>Add a person</b>
          <div className="row-wrap">
            {FIELDS.map(k => <input key={k} className="input" placeholder={{ email: 'Email', firstName: 'First name', lastName: 'Last name', company: 'Company' }[k]} value={person[k]} onChange={e => setPerson({ ...person, [k]: e.target.value })} />)}
          </div>
          {listPicker}{consent}
          <div className="row-wrap">
            <button className="btn primary sm" disabled={!person.email.includes('@') || !listIds.length} onClick={() => api.addSubscriber({ ...person, listIds, attested }).then(r => { done(r); setPerson({ email: '', firstName: '', lastName: '', company: '' }); }).catch(e => toast(errorText(e), true))}>Add</button>
            <button className="btn ghost sm" onClick={() => setMode('')}>Cancel</button>
          </div>
        </div>
      )}

      {mode === 'import' && (
        <div className="card panel">
          <b>Import people from a CSV file</b>
          <input type="file" accept=".csv,text/csv" onChange={e => e.target.files?.[0] && readFile(e.target.files[0])} />
          {csv && (
            <>
              <span className="muted">{csv.rows.length} rows. Match the columns:</span>
              <div className="row-wrap">
                {FIELDS.map(k => (
                  <label key={k} className="nl-field" style={{ flex: '1 1 150px' }}><span>{k}</span>
                    <select className="input" value={csv.map[k] ?? ''} onChange={e => setCsv({ ...csv, map: { ...csv.map, [k]: e.target.value === '' ? -1 : Number(e.target.value) } })}>
                      <option value="">—</option>
                      {csv.head.map((h, i) => <option key={i} value={i}>{h || 'Column ' + (i + 1)}</option>)}
                    </select>
                  </label>
                ))}
              </div>
            </>
          )}
          {listPicker}{consent}
          <div className="row-wrap">
            <button className="btn primary sm" disabled={!csv || (csv.map.email ?? -1) < 0 || !listIds.length} onClick={() => {
              if (!csv) return;
              const rows = csv.rows.map(r => Object.fromEntries(FIELDS.map(k => [k, (csv.map[k] ?? -1) >= 0 ? r[csv.map[k]] || '' : ''])));
              api.importSubscribers(rows, listIds, attested).then(done).catch(e => toast(errorText(e), true));
            }}>Import</button>
            <button className="btn ghost sm" onClick={() => { setMode(''); setCsv(null); }}>Cancel</button>
          </div>
        </div>
      )}

      {open && (
        <div className="card panel">
          <div className="row-wrap" style={{ alignItems: 'center' }}>
            <b>{open.email}</b><span className="pill">{open.status}</span>
            <span className="faint">{open.source} · {open.consentMethod || 'no consent yet'}{open.consentAt ? ' · ' + new Date(open.consentAt).toLocaleDateString() : ''}</span>
            <span style={{ flex: 1 }} />
            <button className="btn ghost sm" onClick={() => setOpen(null)}>Close</button>
          </div>
          <span className="muted">Lists: {open.listIds.map(id => lists.find(l => l.id === id)?.name).filter(Boolean).join(', ') || 'none'} · {open.frequency === 'essentials' ? 'Essentials only' : 'Everything'}</span>
          <div className="row-wrap">
            {open.status === 'subscribed' && <button className="btn sm" onClick={() => api.updateSubscriber(open.id, { status: 'unsubscribed' }).then(s => { setOpen(s); load(); toast('Unsubscribed.'); }).catch(e => toast(errorText(e), true))}>Unsubscribe</button>}
            <button className="btn sm danger" onClick={() => {
              if (window.confirm('Delete ' + open.email + ' and their history? Their address is kept only as a hash, so an import never adds them back.'))
                api.removeSubscriber(open.id).then(() => { setOpen(null); load(); toast('Deleted.'); }).catch(e => toast(errorText(e), true));
            }}>Delete their data</button>
          </div>
          <span className="faint">Only the person can resubscribe, from the link in any newsletter or by signing up again.</span>
        </div>
      )}

      {!data && !err && <div className="card panel an-loading"><div className="spinner" /> Loading…</div>}
      {data && (data.subscribers.length ? (
        <div className="card table table-scroll" aria-label="Subscribers">
          <div className="trow nl-subs head"><span>PERSON</span><span>STATUS</span><span>LISTS</span><span>SOURCE</span><span>ADDED</span></div>
          {data.subscribers.map(s => (
            <button key={s.id} className={'trow nl-subs link-like' + (open?.id === s.id ? ' on' : '')} onClick={() => setOpen(s)}>
              <span className="user-cell"><b>{[s.firstName, s.lastName].filter(Boolean).join(' ') || s.email}</b><span>{s.email}{s.company ? ' · ' + s.company : ''}</span></span>
              <span><span className={'pill' + (s.status === 'subscribed' ? ' ok' : s.status === 'pending' ? ' warn' : '')}>{s.status}</span></span>
              <span className="muted">{s.listIds.map(id => lists.find(l => l.id === id)?.name).filter(Boolean).join(', ')}</span>
              <span className="muted">{s.source}</span>
              <span className="muted">{new Date(s.createdAt).toLocaleDateString()}</span>
            </button>
          ))}
        </div>
      ) : <div className="card panel"><span className="faint">No subscribers match. People join from the website form, or you add or import them here.</span></div>)}
      {data && data.total > 100 && (
        <div className="row-wrap" style={{ alignItems: 'center' }}>
          <button className="btn ghost sm" disabled={q.page === '0'} onClick={() => setQ({ ...q, page: String(Number(q.page) - 1) })}>← Previous</button>
          <span className="muted">Page {Number(q.page) + 1} of {Math.ceil(data.total / 100)} · {data.total} people</span>
          <button className="btn ghost sm" disabled={(Number(q.page) + 1) * 100 >= data.total} onClick={() => setQ({ ...q, page: String(Number(q.page) + 1) })}>Next →</button>
        </div>
      )}
    </>
  );
}
