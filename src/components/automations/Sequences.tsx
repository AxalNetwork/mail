import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Profile } from '../../types';
import { mergeTpl } from '../../lib/bulk';
import { parseCSV } from '../../lib/csv';
import { signatureHtml, signatureText } from '../../lib/signature';
import {
  parseRecipients, type RecipientIn, type RecipientStatus, type SenderStatus, type Sequence, type SequenceStatus, type SequenceSummary, type SequencesApi, type Step
} from '../../lib/sequencesApi';
import { errorText, useToast } from '../Toast';

interface Props {
  api: SequencesApi | null;
  profile: Profile;
  onBack: () => void;
}

const MAX_STEPS = 6;
const STATUS_LABEL: Record<SequenceStatus, string> = { draft: 'Draft · needs approval', approved: 'Approved · not started', active: 'Running', paused: 'Paused', completed: 'Completed', stopped: 'Stopped' };
const STATUS_CLS: Record<SequenceStatus, string> = { draft: 'warn', approved: 'accent', active: 'ok', paused: 'warn', completed: '', stopped: '' };
const R_LABEL: Record<RecipientStatus, string> = { pending: 'Waiting to start', active: 'In sequence', replied: 'Replied', opted_out: 'Opted out', bounced: 'Bounced', stopped: 'Stopped', completed: 'All steps sent', failed: 'Needs attention' };
const R_CLS: Record<RecipientStatus, string> = { pending: '', active: 'accent', replied: 'ok', opted_out: '', bounced: 'danger', stopped: '', completed: '', failed: 'danger' };

const BLANK: { name: string; steps: Step[]; csv: string } = {
  name: '',
  steps: [
    { delayDays: 0, subject: 'Axal VC — {company|a quick introduction}', body: 'Hi {first_name|there},\n\n{opening}' },
    { delayDays: 4, subject: '', body: 'Hi {first_name|there},\n\nFollowing up on my note below in case it got buried.' }
  ],
  csv: 'email,first name,last name,company,context\n'
};

const when = (t: number | null) => (t ? new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');

export function Sequences({ api, profile, onBack }: Props) {
  const toast = useToast();
  const [sender, setSender] = useState<SenderStatus | null>(null);
  const [list, setList] = useState<SequenceSummary[] | null>(null);
  const [open, setOpen] = useState<Sequence | null>(null);
  const [editing, setEditing] = useState<{ id: number | null; name: string; steps: Step[]; csv: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!api) return;
    setError(null);
    try {
      const [s, l] = await Promise.all([api.sender(), api.list()]);
      setSender(s);
      setList(l);
    } catch (e) { setError(errorText(e)); }
  }, [api]);
  useEffect(() => { load(); }, [load]);

  const run = async <T,>(fn: () => Promise<T>, done?: string): Promise<T | null> => {
    setBusy(true);
    try {
      const r = await fn();
      if (done) toast(done);
      return r;
    } catch (e) {
      toast({ text: errorText(e), error: true });
      return null;
    } finally { setBusy(false); }
  };

  if (!api) {
    return (
      <section className="placeholder">
        <h1>Outreach sequences</h1>
        <span className="muted">Sequences send from the Worker on a schedule, so they need the live app signed in with Google (not the demo).</span>
        <button className="btn" onClick={onBack}>Back to AI Automations</button>
      </section>
    );
  }

  const openSeq = async (id: number) => { const s = await run(() => api.get(id)); if (s) { setOpen(s); setEditing(null); } };
  const refreshOpen = (s: Sequence | null) => { if (s) { setOpen(s); load(); } };

  return (
    <section className="admin" aria-label="Investor outreach sequences">
      <div className="page-inner" style={{ gap: 16 }}>
        <div className="page-title">
          <button className="link-btn" style={{ alignSelf: 'flex-start' }} onClick={open || editing ? () => { setOpen(null); setEditing(null); } : onBack}>
            ← {open || editing ? 'All sequences' : 'AI Automations'}
          </button>
          <h1>Investor outreach sequences</h1>
          <span className="muted">A first email and timed follow-ups, sent from your Gmail by the server, so no browser needs to stay open. An admin approves the exact version before anything sends; a reply, a bounce or an unsubscribe stops that person’s sequence.</span>
        </div>

        {error && <div className="card panel"><span className="tone-danger">{error}</span><button className="btn sm" onClick={load}>Try again</button></div>}

        {sender && <SenderCard sender={sender} busy={busy}
          onConnect={async () => { const s = await run(() => api.connect(), 'Sending connected'); if (s) setSender(s); }}
          onDisconnect={async () => { const s = await run(() => api.disconnect(), 'Sending disconnected; running sequences pause at their next send'); if (s) setSender(s); }} />}

        {editing ? (
          <Editor key={editing.id ?? 'new'} initial={editing} busy={busy} profile={profile}
            onCancel={() => setEditing(null)}
            onSave={async (name, steps, recipients) => {
              const input = { name, steps, recipients, signatureHtml: signatureHtml(profile), signatureText: signatureText(profile) };
              const s = await run(() => (editing.id ? api.update(editing.id, input) : api.create(input)), editing.id ? 'Saved as a new version; it needs approval again' : 'Saved. Ask an admin to approve it.');
              if (s) { setEditing(null); refreshOpen(s); }
            }} />
        ) : open ? (
          <Detail s={open} busy={busy} senderReady={!!sender?.connected}
            onEdit={() => setEditing({ id: open.id, name: open.name, steps: open.steps, csv: toCsv(open.recipients.filter(r => r.status === 'pending' || r.status === 'active')) })}
            onApprove={async () => refreshOpen(await run(() => api.approve(open.id, open.version), 'Approved version ' + open.version))}
            onAction={async a => refreshOpen(await run(() => api.action(open.id, a), a === 'start' ? 'Started: the first emails go out within 10 minutes' : a === 'pause' ? 'Paused' : 'Stopped'))}
            onStopRecipient={async (rid, optOut) => refreshOpen(await run(() => api.stopRecipient(open.id, rid, optOut), optOut ? 'Opted out of all outreach' : 'Stopped for this person'))}
            onRefresh={() => openSeq(open.id)} />
        ) : (
          <div className="card table"><div className="table-scroll">
            <div className="trow seqs head"><span>SEQUENCE</span><span>STATUS</span><span>PEOPLE</span><span>UPDATED</span><span /></div>
            {!list && <div className="trow seqs"><span className="muted">Loading…</span></div>}
            {list?.length === 0 && <div className="trow seqs"><span className="muted">No sequences yet.</span></div>}
            {list?.map(s => (
              <button key={s.id} className="trow seqs clickable" onClick={() => openSeq(s.id)}>
                <span className="user-cell"><b>{s.name}</b><span>{s.mine ? 'Yours' : s.owner}</span></span>
                <span><span className={'pill ' + STATUS_CLS[s.status]} style={{ border: 0 }}>{STATUS_LABEL[s.status]}</span>{s.lastError && <span className="tone-danger" style={{ display: 'block', fontSize: 11.5 }}>{s.lastError}</span>}</span>
                <span className="muted" style={{ fontSize: 12 }}>{summarize(s.counts)}</span>
                <span className="muted">{when(s.updatedAt)}</span>
                <span className="faint">›</span>
              </button>
            ))}
            <div className="trow seqs" style={{ borderBottom: 0 }}>
              <span><button className="btn primary sm" onClick={() => setEditing({ id: null, ...BLANK })}>New sequence</button></span>
            </div>
          </div></div>
        )}
      </div>
    </section>
  );
}

function summarize(c: Partial<Record<RecipientStatus, number>>): string {
  const n = (k: RecipientStatus) => c[k] || 0;
  const total = Object.values(c).reduce((a, b) => a + (b || 0), 0);
  const parts = [total + ' people', n('replied') && n('replied') + ' replied', n('active') && n('active') + ' in sequence', n('failed') && n('failed') + ' need attention'];
  return parts.filter(Boolean).join(' · ');
}

function toCsv(rs: RecipientIn[]): string {
  const q = (v: string) => (/[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v);
  return 'email,first name,last name,company,context\n' + rs.map(r => [r.email, r.firstName, r.lastName, r.company, r.context].map(q).join(',')).join('\n');
}

function SenderCard({ sender, busy, onConnect, onDisconnect }: { sender: SenderStatus; busy: boolean; onConnect: () => void; onDisconnect: () => void }) {
  return (
    <div className="card panel">
      <span className="mono-label">Sending</span>
      {sender.connected ? (
        <div className="row-wrap" style={{ alignItems: 'center' }}>
          <span className="pill ok" style={{ border: 0 }}>✓ Connected</span>
          <span>Sends as <b>{sender.googleEmail}</b>{sender.via === 'delegation' ? ' through the Workspace service account' : ''}.</span>
          {sender.via === 'grant' && <button className="btn sm" disabled={busy} onClick={onDisconnect}>Disconnect</button>}
        </div>
      ) : sender.canConnect ? (
        <div className="row-wrap" style={{ alignItems: 'center' }}>
          <span className="muted">Sequences send while you’re away, so Google asks once for permission to send and read your Gmail from the server.</span>
          <button className="btn primary sm" disabled={busy} onClick={onConnect}>Connect sending</button>
        </div>
      ) : (
        <span className="tone-warn" style={{ fontSize: 12.5 }}>Not set up on the server yet: the Worker needs {sender.missing.join(' and ')}. See the README, “Outreach sequences”.</span>
      )}
    </div>
  );
}

function Editor({ initial, busy, profile, onCancel, onSave }: {
  initial: { name: string; steps: Step[]; csv: string }; busy: boolean; profile: Profile;
  onCancel: () => void; onSave: (name: string, steps: Step[], recipients: RecipientIn[]) => void;
}) {
  const [name, setName] = useState(initial.name);
  const [steps, setSteps] = useState<Step[]>(initial.steps);
  const [csv, setCsv] = useState(initial.csv);
  const recipients = useMemo(() => parseRecipients(parseCSV(csv)), [csv]);
  const sample = recipients[0] || { email: 'lena@example.com', firstName: 'Lena', lastName: 'Fischer', company: 'Kestrel Capital', context: 'our call in May' };
  const merge = (t: string) => mergeTpl(t, { first: sample.firstName, last: sample.lastName, company: sample.company, email: sample.email, context: sample.context, persona: 'Investor' }).text;
  const setStep = (i: number, patch: Partial<Step>) => setSteps(ss => ss.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const valid = name.trim() && steps[0].subject.trim() && steps.every(s => s.body.trim()) && recipients.length > 0;

  return (
    <div className="card panel seq-editor">
      <label className="seq-field">Name<input className="input" value={name} maxLength={120} placeholder="Fund II — LP outreach" onChange={e => setName(e.target.value)} /></label>

      {steps.map((s, i) => (
        <div key={i} className="seq-step">
          <div className="row-wrap" style={{ alignItems: 'center' }}>
            <b>{i === 0 ? 'Step 1 · first email' : 'Step ' + (i + 1) + ' · follow-up'}</b>
            {i > 0 && (
              <label className="seq-inline">if no reply after
                <input className="input" type="number" min={1} max={60} value={s.delayDays} onChange={e => setStep(i, { delayDays: Number(e.target.value) })} /> days
              </label>
            )}
            {i > 0 && <button className="btn ghost sm" style={{ marginLeft: 'auto' }} onClick={() => setSteps(ss => ss.filter((_, j) => j !== i))}>Remove</button>}
          </div>
          <input className="input" value={s.subject} maxLength={200} placeholder={i === 0 ? 'Subject' : 'Subject (leave empty to reply in the same thread)'} onChange={e => setStep(i, { subject: e.target.value })} />
          <textarea className="textarea" rows={5} value={s.body} maxLength={10_000} onChange={e => setStep(i, { body: e.target.value })} />
          <details className="seq-preview">
            <summary>Preview for {sample.firstName || sample.email}</summary>
            <b>{i === 0 || s.subject ? merge(s.subject || steps[0].subject) : 'Re: ' + merge(steps[0].subject)}</b>
            <div style={{ whiteSpace: 'pre-wrap' }}>{merge(s.body)}</div>
          </details>
        </div>
      ))}
      <div className="row-wrap">
        {steps.length < MAX_STEPS && <button className="btn sm" onClick={() => setSteps(ss => [...ss, { delayDays: 4, subject: '', body: 'Hi {first_name|there},\n\n' }])}>Add follow-up</button>}
        <span className="muted" style={{ fontSize: 12 }}>Fields: {'{first_name}'}, {'{last_name}'}, {'{company}'}, {'{opening}'} (from the context column). Add a fallback with {'{company|your fund}'}. Your signature and an unsubscribe line are added to every email.</span>
      </div>

      <label className="seq-field">Recipients (CSV: email, first name, last name, company, context)
        <textarea className="textarea mono" rows={6} value={csv} onChange={e => setCsv(e.target.value)} spellCheck={false} />
      </label>
      <span className="muted" style={{ fontSize: 12 }}>{recipients.length} recipient{recipients.length === 1 ? '' : 's'} · from {profile.email}</span>

      <div className="row-wrap">
        <button className="btn primary" disabled={busy || !valid} onClick={() => onSave(name.trim(), steps.map((s, i) => ({ ...s, delayDays: i ? s.delayDays : 0 })), recipients)}>Save for approval</button>
        <button className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function Detail({ s, busy, senderReady, onEdit, onApprove, onAction, onStopRecipient, onRefresh }: {
  s: Sequence; busy: boolean; senderReady: boolean; onEdit: () => void; onApprove: () => void;
  onAction: (a: 'start' | 'pause' | 'stop') => void; onStopRecipient: (id: number, optOut: boolean) => void; onRefresh: () => void;
}) {
  const [reviewed, setReviewed] = useState(false);
  const ended = s.status === 'completed' || s.status === 'stopped';
  return (
    <>
      <div className="card panel">
        <div className="row-wrap" style={{ alignItems: 'center' }}>
          <b style={{ fontSize: 16 }}>{s.name}</b>
          <span className={'pill ' + STATUS_CLS[s.status]} style={{ border: 0 }}>{STATUS_LABEL[s.status]}</span>
          <span className="muted" style={{ fontSize: 12 }}>Version {s.version}{s.approved ? ' · approved by ' + s.approved.by + ', ' + when(s.approved.at) : ''}{s.mine ? '' : ' · owner ' + s.owner}</span>
          <button className="btn ghost sm" style={{ marginLeft: 'auto' }} onClick={onRefresh} aria-label="Refresh">↻</button>
        </div>
        {s.lastError && <span className="tone-danger" style={{ fontSize: 12.5 }}>{s.lastError}</span>}

        {s.status === 'draft' && s.canApprove && (
          <div className="notice accent seq-approve">
            <label className="check-row"><input type="checkbox" checked={reviewed} onChange={() => setReviewed(v => !v)} />
              <span>I reviewed every step and the {s.recipients.length === 1 ? 'recipient' : s.recipients.length + ' recipients'} below.</span></label>
            <button className="btn primary sm" disabled={busy || !reviewed} onClick={onApprove}>Approve version {s.version}</button>
          </div>
        )}
        {s.status === 'draft' && !s.canApprove && <span className="tone-warn" style={{ fontSize: 12.5 }}>Waiting for an admin to approve this version. Nothing sends until then.</span>}

        {s.mine && (
          <div className="row-wrap">
            {(s.status === 'approved' || s.status === 'paused') && s.approved && (
              <button className="btn primary sm" disabled={busy || !senderReady} title={senderReady ? '' : 'Connect sending first'} onClick={() => onAction('start')}>{s.status === 'paused' ? 'Resume' : 'Start sending'}</button>
            )}
            {s.status === 'active' && <button className="btn sm" disabled={busy} onClick={() => onAction('pause')}>Pause</button>}
            {!ended && <button className="btn sm" disabled={busy} onClick={onEdit}>Edit (needs approval again)</button>}
            {!ended && <button className="btn ghost sm" disabled={busy} onClick={() => onAction('stop')}>Stop for everyone</button>}
          </div>
        )}
      </div>

      <div className="card panel">
        <span className="mono-label">Steps</span>
        {s.steps.map((t, i) => (
          <div key={i} className="seq-step-view">
            <span className="muted" style={{ fontSize: 12 }}>{i === 0 ? 'Step 1 · when the sequence starts' : 'Step ' + (i + 1) + ' · ' + t.delayDays + ' days after the previous one, if no reply'}</span>
            <b>{t.subject || 'Re: ' + s.steps[0].subject}</b>
            <div style={{ whiteSpace: 'pre-wrap', fontSize: 13 }}>{t.body}</div>
          </div>
        ))}
        <span className="muted" style={{ fontSize: 12 }}>Every email ends with your signature and “Reply ‘unsubscribe’ and we won’t email you again.”</span>
      </div>

      <div className="card table"><div className="table-scroll">
        <div className="trow seq-people head"><span>RECIPIENT</span><span>STATUS</span><span>NEXT</span><span /></div>
        {s.recipients.map(r => (
          <div key={r.id} className="trow seq-people">
            <span className="user-cell"><b>{[r.firstName, r.lastName].filter(Boolean).join(' ') || r.email}</b><span>{r.email}{r.company ? ' · ' + r.company : ''}</span></span>
            <span><span className={'pill ' + R_CLS[r.status]} style={{ border: 0 }}>{R_LABEL[r.status]}</span>{r.lastError && <span className="tone-danger" style={{ display: 'block', fontSize: 11.5 }}>{r.lastError}</span>}</span>
            <span className="muted" style={{ fontSize: 12 }}>{r.status === 'active' ? 'Step ' + (r.nextStep + 1) + ' · ' + when(r.nextAt) : r.status === 'pending' ? 'Step 1 when started' : '—'}</span>
            <span className="row-wrap" style={{ justifyContent: 'flex-end' }}>
              {s.mine && (r.status === 'pending' || r.status === 'active') && (
                <>
                  <button className="btn ghost sm" disabled={busy} onClick={() => onStopRecipient(r.id, false)}>Stop</button>
                  <button className="btn ghost sm" disabled={busy} onClick={() => onStopRecipient(r.id, true)}>Opt out</button>
                </>
              )}
            </span>
          </div>
        ))}
      </div></div>
    </>
  );
}
