import { useCallback, useEffect, useState } from 'react';
import { TEMPLATE_NAME } from '../../lib/newsletter/render';
import type { Issue, NewslettersApi, NlList, RecipientStatus, Report } from '../../lib/newslettersApi';
import { statusPill } from '../../lib/newslettersApi';
import { errorText } from '../Toast';

const FIGS: [keyof Report['figures'], string, string][] = [
  ['recipients', 'Recipients', 'On the list when sending started'],
  ['accepted', 'Accepted', 'Accepted by the mail provider for sending'],
  ['failed', 'Failed', 'Refused when sending, each with a reason'],
  ['unconfirmed', 'Unconfirmed', 'No answer from the provider. Check Sent mail'],
  ['replies', 'Replies', 'Replies received by the sending mailbox'],
  ['bounces', 'Bounce notices', 'Bounce emails received after sending'],
  ['unsubscribes', 'Unsubscribes', 'One click, a reply or an email; reported to StudioOS']
];
const FILTERS: ['' | RecipientStatus, string][] = [['', 'All'], ['accepted', 'Accepted'], ['failed', 'Failed'], ['unconfirmed', 'Unconfirmed'], ['bounced', 'Bounced'], ['unsubscribed', 'Unsubscribed'], ['replied', 'Replied'], ['skipped', 'Skipped'], ['queued', 'Waiting']];
const TONE: Record<RecipientStatus, string> = { accepted: 'ok', failed: 'danger', unconfirmed: 'warn', skipped: '', queued: '', unsubscribed: '', bounced: 'danger', replied: 'accent' };
const LABEL: Record<RecipientStatus, string> = { accepted: 'Accepted', failed: 'Failed', unconfirmed: 'Unconfirmed', skipped: 'Skipped', queued: 'Waiting', unsubscribed: 'Unsubscribed', bounced: 'Bounced', replied: 'Replied' };
const time = (t: number | null) => (t ? new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '—');

interface Props {
  api: NewslettersApi;
  issue: Issue;
  lists: NlList[];
  canManage: boolean;
  onBack: () => void;
  onDuplicate: () => void;
  onChanged: (i: Issue) => void;
  toast: (text: string, error?: boolean) => void;
}

/** A newsletter that is sending or sent: figures, what the provider confirms, and each recipient. */
export function SentView({ api, issue, lists, canManage, onBack, onDuplicate, onChanged, toast }: Props) {
  const [rep, setRep] = useState<Report | null>(null);
  const [err, setErr] = useState('');
  const [q, setQ] = useState({ q: '', status: '' });

  const load = useCallback(() => {
    setErr('');
    api.report(issue.id, q).then(setRep).catch(e => setErr(errorText(e)));
  }, [api, issue.id, q]);
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [load]);
  useEffect(() => {
    if (issue.status !== 'sending') return;
    const t = setInterval(() => { api.get(issue.id).then(r => onChanged(r.issue)).catch(() => {}); load(); }, 30_000);
    return () => clearInterval(t);
  }, [api, issue.id, issue.status, load, onChanged]);

  const pill = statusPill(issue);
  const audience = [...issue.listIds.map(id => lists.find(l => l.id === id)?.name).filter(Boolean), ...issue.audiences.map(k => (k.startsWith('testers:') ? 'Picked testers' : k))].join(', ') || '—';
  const act = (name: 'cancel' | 'resume') => api.action(issue.id, name).then(i => { onChanged(i); toast(name === 'cancel' ? 'Paused.' : 'Resumed.'); }).catch(e => toast(errorText(e), true));

  return (
    <div className="nl-editor">
      <div className="nl-head">
        <div className="nl-head-main">
          <span className="mono-label"><button className="link-btn plain" onClick={onBack}>Newsletters</button> / {issue.status === 'sent' ? 'Sent' : 'Sending'}</span>
          <div className="row-wrap" style={{ alignItems: 'center', gap: 10 }}>
            <h1 style={{ fontSize: 22 }}>{issue.title}</h1>
            <span className={'pill ' + pill.tone}>{pill.label}</span>
          </div>
          <span className="muted">From {issue.fromEmail || issue.senderMember || 'the sending address'} to {audience} · {TEMPLATE_NAME[issue.template]} · Version {issue.version}{issue.approvedBy ? ', approved by ' + issue.approvedBy : ''}</span>
        </div>
        <div className="row-wrap">
          {canManage && issue.status === 'sending' && <button className="btn sm" onClick={() => act('cancel')}>Pause sending</button>}
          {canManage && issue.status === 'paused' && <button className="btn sm" onClick={() => act('resume')}>Resume</button>}
          <button className="btn sm" onClick={onDuplicate}>Duplicate as next issue</button>
        </div>
      </div>

      {issue.lastError && <div className={'notice ' + (issue.lastError.startsWith('Paused at') ? 'accent' : 'warn')}>{issue.lastError}</div>}
      {err && <div className="notice warn" role="alert">{err} <button className="link-btn" onClick={load}>Try again</button></div>}

      <div className="nl-figs">
        {FIGS.map(([k, l, sub]) => (
          <div key={k} className="card nl-fig">
            <span className="mono-label">{l}</span>
            <b>{rep ? (rep.figures[k] ?? '—') : '…'}</b>
            <span className="faint">{k === 'replies' || k === 'bounces' ? (rep?.figures[k] == null ? 'Not read from the mailbox yet' : sub) : sub}</span>
          </div>
        ))}
      </div>
      <div className="card panel nl-notes">
        <span><b>Delivery: unknown.</b> The mail provider confirms acceptance only.</span>
        <span><b>Opens and clicks: not tracked.</b> That needs tracking pixels or tracked links.</span>
      </div>

      <div className="card panel">
        <div className="row-wrap" style={{ alignItems: 'center' }}>
          <span className="mono-label">Recipients</span>
          <span className="pill">{rep?.total ?? '…'}</span>
          <span style={{ flex: 1 }} />
          <input className="input" type="search" placeholder="Search name or email" aria-label="Search recipients" value={q.q} onChange={e => setQ({ ...q, q: e.target.value })} />
        </div>
        <div className="row-wrap">
          {FILTERS.map(([k, l]) => <button key={k} className={'btn sm ' + (q.status === k ? 'soft' : 'ghost')} onClick={() => setQ({ ...q, status: k })}>{l}</button>)}
        </div>
      </div>
      {rep && (rep.recipients.length ? (
        <div className="card table table-scroll" aria-label="Recipients">
          <div className="trow nl-rcpt head"><span>PERSON</span><span>EMAIL</span><span>STATUS</span><span>TIME</span><span>DETAIL</span></div>
          {rep.recipients.map((r, i) => (
            <div key={r.email + i} className="trow nl-rcpt">
              <span>{r.name || '—'}</span>
              <span className="muted">{r.email}</span>
              <span><span className={'pill ' + TONE[r.status]}>{LABEL[r.status]}</span></span>
              <span className="muted">{time(r.time)}</span>
              <span className="faint">{r.detail || '—'}</span>
            </div>
          ))}
        </div>
      ) : <div className="card panel"><span className="faint">Nobody matches.</span></div>)}
      {!rep && !err && <div className="card panel nl-skel" aria-label="Loading"><span /><span /><span /></div>}
    </div>
  );
}
