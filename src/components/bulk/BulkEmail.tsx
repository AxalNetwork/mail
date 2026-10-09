import { useEffect, useMemo, useRef, useState } from 'react';
import type { Account, Identity, OutgoingMessage } from '../../types';
import type { MailProvider } from '../../providers/types';
import type { Assistant } from '../../assistant/types';
import type { View } from '../Sidebar';
import {
  BULK_FIELDS, MAX_ROWS, MERGE_TOKENS, OPTOUT_LINE, PERSONAS, autoMap, bulkRows, mergeTpl, needsApproval, presentPersonas,
  type BulkRow, type PersonaKey, type PersonaMessage
} from '../../lib/bulk';
import { parseCSV } from '../../lib/csv';
import { plural } from '../../lib/format';
import { textToHtml } from '../../lib/html';
import { assembleHtml, assembleText } from '../../lib/outgoing';
import { signatureHtml, signatureText } from '../../lib/signature';
import { DEFAULT_BRIEF, SAMPLE_CSV } from '../../providers/demo/data';
import { EmailSignature } from '../EmailSignature';
import { errorText, useToast } from '../Toast';

interface Props {
  provider: MailProvider;
  assistant: Assistant;
  account: Account;
  identities: Identity[];
  onDone: (folder: View) => void;
}

interface Progress {
  done: number;
  total: number;
  failed: string[];
}

interface State {
  step: 1 | 2 | 3 | 4;
  maxStep: number;
  fileName: string;
  headers: string[];
  data: string[][];
  map: Record<string, number>;
  excluded: Record<number, boolean>;
  included: Record<number, boolean>;
  personaOv: Record<number, PersonaKey>;
  pasteOpen: boolean;
  pasteText: string;
  brief: string;
  msgs: Partial<Record<PersonaKey, PersonaMessage>>;
  writing: string | null;
  pIdx: number;
  overrides: Record<number, string>;
  editOne: boolean;
  fromId: string;
  when: string;
  optout: boolean;
  reviewed: boolean;
  error: string | null;
}

const STEP_LABELS = ['Recipients', 'Personas & messages', 'Preview', 'Review & send'];
const STATUS: Record<BulkRow['status'], [string, string]> = {
  ready: ['Ready', 'ok'], internal: ['Internal', ''], duplicate: ['Duplicate', 'warn'], invalid: ['Invalid email', 'danger'], optout: ['Opted out', '']
};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export function BulkEmail({ provider, assistant, account, identities, onDone }: Props) {
  const toast = useToast();
  const demo = provider.capabilities.demo;
  const initial = (): State => ({
    step: 1, maxStep: 1, fileName: '', headers: [], data: [], map: {}, excluded: {}, included: {}, personaOv: {}, pasteOpen: false,
    pasteText: '', brief: demo ? DEFAULT_BRIEF : '', msgs: {}, writing: null, pIdx: 0, overrides: {}, editOne: false,
    fromId: (identities.find(i => i.isDefault) || identities[0]).id, when: 'now', optout: true, reviewed: false, error: null
  });
  const [b, setB] = useState<State>(initial);
  const [optOuts, setOptOuts] = useState<Record<string, string>>({});
  const [progress, setProgress] = useState<Progress | null>(null);
  const [drag, setDrag] = useState(false);
  const csvRef = useRef<HTMLInputElement>(null);
  const lastField = useRef<{ p: PersonaKey; f: 'subject' | 'body'; el: HTMLInputElement | HTMLTextAreaElement } | null>(null);
  const cancel = useRef(false);

  useEffect(() => { provider.optOuts().then(setOptOuts).catch(() => {}); }, [provider]);

  const set = (patch: Partial<State> | ((s: State) => Partial<State>)) =>
    setB(s => ({ ...s, error: null, ...(typeof patch === 'function' ? patch(s) : patch) }));

  const rows = useMemo(() => bulkRows({ ...b, optOuts, orgDomain: provider.orgDomain }), [b, optOuts, provider.orgDomain]);
  const inc = rows.filter(r => r.include);
  const present = presentPersonas(inc);
  const identity = identities.find(i => i.id === b.fromId) || identities[0];
  const schedules = provider.scheduleOptions();
  const sched = schedules.find(o => o.when === b.when) || null;
  const sigHtml = useMemo(() => signatureHtml(account.profile), [account.profile]);

  const loadCsv = (text: string, name: string) => {
    const parsed = parseCSV(text || '');
    if (parsed.length < 2) return set({ error: 'The CSV needs a header row and at least one data row.' });
    const headers = parsed[0].map(h => h.trim());
    const data = parsed.slice(1);
    if (data.length > MAX_ROWS) return set({ error: data.length + ' rows. The limit is ' + MAX_ROWS + ' per batch; split the file.' });
    set({ fileName: name, headers, data, map: autoMap(headers), excluded: {}, included: {}, personaOv: {}, overrides: {}, pasteOpen: false, pIdx: 0, msgs: {} });
  };
  const readFile = (f: File | undefined) => {
    if (!f) return;
    f.text().then(t => loadCsv(t, f.name)).catch(e => set({ error: errorText(e) }));
  };

  const write = async (key: PersonaKey | null) => {
    if (!b.brief.trim()) return set({ error: 'Add a campaign brief first.' });
    const keys = key ? [present.find(p => p.key === key)!] : present;
    set({ writing: key || 'all' });
    try {
      const results = await Promise.all(keys.map(p => assistant.writePersona(p.key, p.tone, b.brief.trim()).then(m => [p.key, m] as const)));
      set(s => ({ msgs: { ...s.msgs, ...Object.fromEntries(results) }, writing: null }));
    } catch (e) {
      set({ writing: null, error: 'Could not write: ' + errorText(e) });
    }
  };

  const insertToken = (tok: string) => {
    const L = lastField.current;
    if (!L) return;
    const el = L.el;
    const st = el.selectionStart ?? el.value.length;
    const en = el.selectionEnd ?? st;
    const v = el.value.slice(0, st) + tok + el.value.slice(en);
    set(s => ({ msgs: { ...s.msgs, [L.p]: { ...s.msgs[L.p]!, [L.f]: v } } }));
    setTimeout(() => { el.focus(); el.setSelectionRange(st + tok.length, st + tok.length); }, 0);
  };

  const mergedFor = (r: BulkRow) => {
    const m = b.msgs[r.persona] || { subject: '', body: '' };
    const sj = mergeTpl(m.subject, r);
    const bd = mergeTpl(m.body, r);
    return { subject: sj.text, body: b.overrides[r.i] ?? bd.text, missing: [...new Set([...sj.missing, ...bd.missing])] };
  };

  const next = () => {
    if (b.step === 1) {
      if (!b.data.length) return set({ error: 'Import a CSV first.' });
      if (!(b.map.email >= 0)) return set({ error: 'Map the email column.' });
      if (!inc.length) return set({ error: 'No rows are included.' });
    }
    if (b.step === 2) {
      const missing = present.filter(p => !b.msgs[p.key]?.body.trim() || !b.msgs[p.key]?.subject.trim()).map(p => p.key);
      if (missing.length) return set({ error: 'Write a subject and message for: ' + missing.join(', ') + '.' });
    }
    if (b.step === 4) return send();
    const step = (b.step + 1) as State['step'];
    set({ step, maxStep: Math.max(b.maxStep, step), editOne: false });
  };

  const send = async () => {
    if (!b.reviewed) return set({ error: 'Confirm that you have reviewed the messages.' });
    const list = inc;
    const failed: string[] = [];
    let sent = 0;
    let held = 0;
    cancel.current = false;
    setProgress({ done: 0, total: list.length, failed });
    for (let i = 0; i < list.length; i++) {
      if (cancel.current) break;
      const r = list[i];
      const mg = mergedFor(r);
      const footer = b.optout ? OPTOUT_LINE : undefined;
      const msg: OutgoingMessage = {
        identity, to: [{ name: [r.first, r.last].filter(Boolean).join(' ') || r.email, email: r.email, org: r.company }], cc: [], bcc: [],
        subject: mg.subject, html: assembleHtml(textToHtml(mg.body), sigHtml, null, footer), text: assembleText(mg.body, signatureText(account.profile), null, footer),
        attachments: [], priority: 'Normal', schedule: sched
      };
      const hold = needsApproval(r.persona);
      try {
        if (hold) { await provider.saveDraft(msg); held++; } else { await provider.send(msg); sent++; }
      } catch (e) {
        failed.push(r.email + ': ' + errorText(e));
      }
      setProgress({ done: i + 1, total: list.length, failed: [...failed] });
      if (!hold && provider.capabilities.bulkSpacingMs && i < list.length - 1) await sleep(provider.capabilities.bulkSpacingMs);
    }
    const stopped = cancel.current;
    setProgress(null);
    const parts = [
      demo ? sent + ' recorded in demo mode, not delivered' : plural(sent, 'email') + (sched ? ' scheduled' : ' sent'),
      held ? held + (demo ? ' held for approval' : ' saved to Drafts for partner approval') : '',
      failed.length ? failed.length + ' failed' : '',
      stopped ? 'stopped early' : ''
    ].filter(Boolean);
    toast({ text: parts.join(' · '), error: failed.length > 0 });
    if (failed.length) console.warn('Bulk send failures:\n' + failed.join('\n'));
    setB(initial());
    onDone(sched ? 'scheduled' : 'sent');
  };

  // ---------- step views ----------

  const sendable = inc.filter(r => !needsApproval(r.persona)).length;
  const heldCount = inc.length - sendable;
  const excl = rows.length - inc.length;
  const idx = Math.min(b.pIdx, Math.max(0, inc.length - 1));
  const cur = inc[idx];
  const hint = { 1: inc.length + ' of ' + rows.length + ' rows included', 2: plural(present.length, 'persona') + ' · ' + plural(inc.length, 'recipient'), 3: 'Each person gets their own email. Recipients never see each other.', 4: '' }[b.step];
  const nextLabel = b.step === 1 ? 'Continue to messages' : b.step === 2 ? 'Preview emails' : b.step === 3 ? 'Review and send'
    : (sched ? 'Schedule ' : 'Send ') + sendable + (heldCount ? ' · hold ' + heldCount + ' for approval' : ' emails');
  const cnt = (st: BulkRow['status']) => rows.filter(r => r.status === st).length;

  return (
    <section className="page" aria-label="Bulk email">
      <input type="file" accept=".csv,text/csv" ref={csvRef} style={{ display: 'none' }} onChange={e => { readFile(e.target.files?.[0]); e.target.value = ''; }} />
      <div className="page-head">
        <div className="page-title">
          <h1>Bulk email</h1>
          <span className="muted">Import a CSV, write one message per persona, and send each person an individual, personalized email.</span>
        </div>
        <div className="steps">
          {STEP_LABELS.map((label, i) => {
            const n = i + 1;
            const cls = n === b.step ? ' on' : n < b.step ? ' done reach' : n <= b.maxStep ? ' reach' : '';
            return (
              <button key={label} className={'step' + cls} disabled={n > b.maxStep || !!progress} aria-current={n === b.step ? 'step' : undefined}
                onClick={() => set({ step: n as State['step'], editOne: false })}>
                <span className="num">{n < b.step ? '✓' : n}</span><span>{label}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="page-scroll">
        <div className="page-inner">
          {b.step === 1 && !b.data.length && (
            <div className={'dropzone' + (drag ? ' drag' : '')}
              onDragOver={e => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
              onDrop={e => { e.preventDefault(); setDrag(false); readFile(e.dataTransfer.files[0]); }}>
              <span className="mono-label">Step 1 · Recipients</span>
              <h2>Import recipients from a CSV</h2>
              <p>One row per person. Columns are matched automatically and you can change the mapping. Up to {MAX_ROWS} rows per batch.</p>
              <div className="row-wrap" style={{ justifyContent: 'center', gap: 8 }}>
                <button className="btn primary lg" onClick={() => csvRef.current?.click()}>Choose CSV file</button>
                <button className="btn lg" onClick={() => set({ pasteOpen: !b.pasteOpen })}>Paste CSV</button>
                {demo && <button className="btn lg" onClick={() => loadCsv(SAMPLE_CSV, 'sample_contacts.csv')}>Use sample data</button>}
              </div>
              <div className="row-wrap" style={{ justifyContent: 'center', alignItems: 'center' }}>
                <span className="faint" style={{ fontSize: 12 }}>Recognised columns</span>
                {BULK_FIELDS.map(f => <span key={f.k} className="col-pill">{f.k}</span>)}
              </div>
              {b.pasteOpen && (
                <div className="paste">
                  <textarea className="textarea mono" rows={7} aria-label="CSV rows" placeholder="email,first_name,company,persona" value={b.pasteText} onChange={e => set({ pasteText: e.target.value })} />
                  <button className="btn primary" style={{ alignSelf: 'flex-end' }} onClick={() => loadCsv(b.pasteText, 'Pasted rows')}>Import pasted rows</button>
                </div>
              )}
            </div>
          )}

          {b.step === 1 && b.data.length > 0 && (
            <>
              <div className="card file-bar">
                <span className="ext-tag">CSV</span>
                <b>{b.fileName}</b>
                <span className="mono muted" style={{ fontSize: 11 }}>{rows.length} rows · {b.headers.length} columns</span>
                <div className="actions">
                  <button className="btn sm" onClick={() => csvRef.current?.click()}>Replace file</button>
                  <button className="btn sm danger" onClick={() => setB(initial())}>Clear</button>
                </div>
              </div>
              <div className="card panel">
                <span className="mono-label">Column mapping</span>
                <div className="mapping">
                  {BULK_FIELDS.map(f => (
                    <label key={f.k}>
                      <span>{f.label}</span>
                      <select className={'select' + (f.k === 'email' && !(b.map.email >= 0) ? ' bad' : '')} value={String(b.map[f.k] ?? -1)}
                        onChange={e => { const v = +e.target.value; set(s => ({ map: { ...s.map, [f.k]: v } })); }}>
                        <option value="-1">— Not mapped</option>
                        {b.headers.map((h, i) => <option key={i} value={String(i)}>{h || 'Column ' + (i + 1)}</option>)}
                      </select>
                    </label>
                  ))}
                </div>
              </div>
              <div className="counts">
                <span className="count-pill accent"><b>{inc.length}</b>included</span>
                {([['ready', 'ready'], ['internal', 'internal · excluded unless ticked'], ['duplicate', 'duplicates skipped'], ['invalid', 'invalid'], ['optout', 'opted out']] as const)
                  .filter(([k]) => cnt(k)).map(([k, l]) => (
                    <span key={k} className={'count-pill tone-' + (STATUS[k][1] === 'ok' ? 'accent' : STATUS[k][1] || 'muted')}><b>{cnt(k)}</b>{l}</span>
                  ))}
              </div>
              <div className="card table">
                <div className="table-scroll">
                  <div className="trow recip head"><span /><span>NAME</span><span>EMAIL</span><span>COMPANY</span><span>PERSONA</span><span>STATUS</span></div>
                  {rows.slice(0, 200).map(r => {
                    const locked = !(r.status === 'ready' || r.status === 'internal');
                    const hintText = r.hint || (r.raw && r.raw !== r.persona ? 'From "' + r.raw + '"' : '');
                    return (
                      <div key={r.i} className={'trow recip' + (r.include ? '' : ' off')}>
                        <input type="checkbox" aria-label={'Include ' + (r.email || 'row ' + (r.i + 1))} checked={r.include} disabled={locked}
                          onChange={() => set(s => r.status === 'internal' ? { included: { ...s.included, [r.i]: !s.included[r.i] } } : { excluded: { ...s.excluded, [r.i]: !s.excluded[r.i] } })} />
                        <span className="ellipsis" style={{ fontWeight: 500 }}>{[r.first, r.last].filter(Boolean).join(' ') || '—'}</span>
                        <span className="ellipsis" style={{ color: 'var(--ink-2)' }}>{r.email || '—'}</span>
                        <span className="ellipsis muted">{r.company || '—'}</span>
                        <select className="select sm" aria-label="Persona" value={r.persona} onChange={e => { const v = e.target.value as PersonaKey; set(s => ({ personaOv: { ...s.personaOv, [r.i]: v } })); }}>
                          {PERSONAS.map(p => <option key={p.key} value={p.key}>{p.key}</option>)}
                        </select>
                        <span className="status-cell">
                          <span className={'pill ' + STATUS[r.status][1]} style={{ border: 0 }}>{STATUS[r.status][0]}</span>
                          {hintText && <span className="hint ellipsis">{hintText}</span>}
                        </span>
                      </div>
                    );
                  })}
                  {rows.length > 200 && <div className="more-rows">Showing the first 200 of {rows.length} rows. All rows are included in the send.</div>}
                </div>
              </div>
            </>
          )}

          {b.step === 2 && (
            <div className="two-col">
              <div className="card brief sticky">
                <span className="mono-label">Campaign brief</span>
                <textarea className="textarea" rows={4} aria-label="Campaign brief" placeholder="What is this email about?" value={b.brief} onChange={e => set({ brief: e.target.value })} />
                <span className="help">{assistant.live ? 'The assistant writes from this brief and each row\'s fields only. It does not add facts.' : 'No assistant is connected, so each persona starts from a standard invitation template built from this brief.'}</span>
                <button className="btn primary lg" disabled={!!b.writing} onClick={() => write(null)}>
                  {b.writing === 'all' ? 'Writing ' + present.length + ' versions…' : '✦ Write for each persona'}
                </button>
                <hr />
                <span className="mono-label">Merge fields</span>
                <div className="row-wrap" style={{ gap: 5 }}>
                  {MERGE_TOKENS.map(tok => <button key={tok} className="token" onMouseDown={e => { e.preventDefault(); insertToken(tok); }}>{tok}</button>)}
                </div>
                <span className="help">Click to insert at the cursor. Text after | is the fallback when a row is empty. {'{opening}'} adds a line from the context column.</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {present.map(p => {
                  const m = b.msgs[p.key];
                  const n = inc.filter(r => r.persona === p.key).length;
                  const busy = b.writing === 'all' || b.writing === p.key;
                  const upd = (f: 'subject' | 'body') => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
                    const v = e.target.value;
                    set(s => ({ msgs: { ...s.msgs, [p.key]: { ...s.msgs[p.key]!, [f]: v } } }));
                  };
                  return (
                    <div key={p.key} className="card persona">
                      <div className="persona-head">
                        <b>{p.key}</b>
                        <span className="col-pill">{plural(n, 'recipient')}</span>
                        {p.approval && <span className="pill danger">Partner approval before send</span>}
                        <button className="btn soft sm" disabled={!!b.writing} onClick={() => write(p.key)}>{busy ? 'Writing…' : m ? '✦ Rewrite' : '✦ Write'}</button>
                      </div>
                      <span className="tone">Tone: {p.tone}</span>
                      {!m ? (
                        <div className="persona-empty">
                          <span>Not written yet.</span>
                          <button className="link-btn" onClick={() => set(s => ({ msgs: { ...s.msgs, [p.key]: { subject: '', body: 'Hi {first_name},\n\n' } } }))}>Start blank</button>
                        </div>
                      ) : (
                        <>
                          <input className="input" style={{ fontWeight: 600 }} aria-label={p.key + ' subject'} placeholder="Subject" value={m.subject} onChange={upd('subject')}
                            onFocus={e => { lastField.current = { p: p.key, f: 'subject', el: e.target }; }} />
                          <textarea className="textarea" rows={10} aria-label={p.key + ' message'} style={{ lineHeight: 1.55, fontSize: 13.5 }} value={m.body} onChange={upd('body')}
                            onFocus={e => { lastField.current = { p: p.key, f: 'body', el: e.target }; }} />
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {b.step === 3 && cur && (() => {
            const mg = mergedFor(cur);
            const edited = b.overrides[cur.i] != null;
            return (
              <div className="two-col narrow">
                <div className="card prev-list">
                  <span className="mono-label">{inc.length} recipients</span>
                  {inc.map((r, j) => (
                    <button key={r.i} className={'prev-item' + (j === idx ? ' on' : '')} onClick={() => set({ pIdx: j, editOne: false })}>
                      <span className="top">
                        <b className="ellipsis">{[r.first, r.last].filter(Boolean).join(' ') || r.email}</b>
                        {mergedFor(r).missing.length > 0 && b.overrides[r.i] == null && <span className="warn-dot" title="Missing fields" />}
                        {b.overrides[r.i] != null && <span style={{ fontSize: 10.5, color: 'var(--accent-strong)' }}>Edited</span>}
                      </span>
                      <span className="sub">{r.persona} · {r.company || r.email}</span>
                    </button>
                  ))}
                </div>
                <div className="card preview">
                  <div className="preview-bar">
                    <button className="btn sm" onClick={() => set({ pIdx: Math.max(0, idx - 1), editOne: false })}>‹ Prev</button>
                    <button className="btn sm" onClick={() => set({ pIdx: Math.min(inc.length - 1, idx + 1), editOne: false })}>Next ›</button>
                    <span className="mono muted" style={{ fontSize: 11, paddingLeft: 4 }}>{idx + 1} of {inc.length}</span>
                    <div className="right">
                      {edited && <button className="btn ghost sm" onClick={() => set(s => { const o = { ...s.overrides }; delete o[cur.i]; return { overrides: o, editOne: false }; })}>Reset to persona message</button>}
                      <button className="btn soft sm" onClick={() => set(s => ({ editOne: !s.editOne, overrides: s.editOne || s.overrides[cur.i] != null ? s.overrides : { ...s.overrides, [cur.i]: mg.body } }))}>
                        {b.editOne ? 'Done' : 'Edit for this person only'}
                      </button>
                    </div>
                  </div>
                  <div className="preview-head">
                    <div className="kv-row"><span className="mono-key">FROM</span><span>{identity.name} &lt;{identity.addr}&gt;</span></div>
                    <div className="kv-row"><span className="mono-key">TO</span><span>{([cur.first, cur.last].filter(Boolean).join(' ') || cur.email) + ' <' + cur.email + '>'}</span></div>
                    <div className="kv-row"><span className="mono-key">SUBJECT</span><span style={{ fontWeight: 600 }}>{mg.subject}</span></div>
                  </div>
                  {mg.missing.length > 0 && !edited && <div className="notice warn">Empty for this person: {mg.missing.join(', ')}. The text was left out.</div>}
                  {b.editOne
                    ? <textarea className="textarea" rows={14} aria-label="Message for this person" style={{ borderColor: 'var(--accent-line)', fontSize: 14, lineHeight: 1.6 }} value={mg.body}
                        onChange={e => { const v = e.target.value; set(s => ({ overrides: { ...s.overrides, [cur.i]: v } })); }} />
                    : <div className="preview-text">{mg.body}</div>}
                  <div className="sig"><EmailSignature profile={account.profile} /></div>
                  {b.optout && <div className="optout">{OPTOUT_LINE}</div>}
                  <div style={{ height: 16 }} />
                </div>
              </div>
            );
          })()}

          {b.step === 4 && (
            <div className="two-col rev">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div className="card settings">
                  <div className="setting">
                    <span className="mono-key">FROM</span>
                    <select className="select" style={{ maxWidth: 420 }} aria-label="From" value={b.fromId} onChange={e => set({ fromId: e.target.value })}>
                      {identities.map(i => <option key={i.id} value={i.id}>{i.name + ' <' + i.addr + '> · ' + i.short}</option>)}
                    </select>
                  </div>
                  <div className="setting">
                    <span className="mono-key">WHEN</span>
                    <select className="select" style={{ maxWidth: 260 }} aria-label="When" value={b.when} onChange={e => set({ when: e.target.value })} disabled={!schedules.length}
                      title={schedules.length ? undefined : 'Scheduled send is not available through the Gmail API'}>
                      <option value="now">Send now</option>
                      {schedules.map(o => <option key={o.when} value={o.when}>{o.label + ' · ' + o.when}</option>)}
                    </select>
                  </div>
                  <div className="setting">
                    <span className="mono-key">DELIVERY</span>
                    <span>One email per person, addressed only to them. Recipients never see each other. {demo ? 'Throttled to 30 per minute; duplicates are skipped.' : 'Sent from your Gmail account at about 30 per minute; duplicates are skipped. Gmail\'s daily sending limit applies (500 for personal accounts, 2,000 for Google Workspace).'}</span>
                  </div>
                  <label className="setting" style={{ cursor: 'pointer' }}>
                    <span className="mono-key">OPT-OUT</span>
                    <span className="check"><input type="checkbox" checked={b.optout} onChange={() => set({ optout: !b.optout })} />Add a line letting recipients opt out of future bulk emails</span>
                  </label>
                </div>
                <div className="card table">
                  <div className="trow breakdown head"><span>PERSONA</span><span>RECIPIENTS</span><span>OUTCOME</span></div>
                  {present.map(p => (
                    <div key={p.key} className="trow breakdown">
                      <b style={{ fontWeight: 600 }}>{p.key}</b>
                      <span className="mono">{inc.filter(r => r.persona === p.key).length}</span>
                      <span><span className={'pill ' + (p.approval ? 'danger' : 'ok')} style={{ border: 0, fontSize: 11.5, padding: '2px 9px' }}>
                        {p.approval ? (demo ? 'Held for partner approval' : 'Saved as drafts for approval') : sched ? 'Scheduled · ' + sched.when : 'Send'}
                      </span></span>
                    </div>
                  ))}
                  <div className="more-rows">{excl ? plural(excl, 'row') + ' excluded (invalid, duplicate, opted out, internal or unticked).' : 'No rows excluded.'}</div>
                </div>
              </div>
              <div className="card summary">
                <span className="mono-label">Summary</span>
                <div className="big-num"><b>{sendable}</b><span className="muted">{sched ? 'emails scheduled for ' + sched.when : 'emails will be sent'}</span></div>
                {heldCount > 0 && <div className="big-num held"><b>{heldCount}</b><span className="muted">{demo ? 'held for approval by Priya Natarajan' : 'saved to your Drafts for partner approval'}</span></div>}
                {demo
                  ? <span className="notice warn">Demo mode: messages are recorded here and not delivered.</span>
                  : <span className="notice accent">These messages will be delivered from {identity.addr}.</span>}
                <label className="check" style={{ alignItems: 'flex-start', lineHeight: 1.45 }}>
                  <input type="checkbox" style={{ marginTop: 2 }} checked={b.reviewed} onChange={() => set({ reviewed: !b.reviewed })} />
                  <span>I've previewed the messages and checked the sender and recipient list.</span>
                </label>
                {progress && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }} aria-live="polite">
                    <div className="progress"><div style={{ width: (progress.done / progress.total) * 100 + '%' }} /></div>
                    <span className="muted">{progress.done} of {progress.total} processed{progress.failed.length ? ' · ' + progress.failed.length + ' failed' : ''}</span>
                    <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => { cancel.current = true; }}>Stop</button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="page-foot">
        {b.step > 1 && <button className="btn lg" disabled={!!progress} onClick={() => set({ step: (b.step - 1) as State['step'], editOne: false })}>Back</button>}
        <span className="muted">{hint}</span>
        {b.error && <span className="err" role="alert">{b.error}</span>}
        <button className={'btn primary lg' + (b.step === 4 && !b.reviewed ? ' off' : '')} disabled={!!progress} onClick={next}>
          {progress ? 'Sending…' : nextLabel}
        </button>
      </div>
    </section>
  );
}
