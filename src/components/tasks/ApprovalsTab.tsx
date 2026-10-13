import { useCallback, useEffect, useState } from 'react';
import type { Profile } from '../../types';
import type { MailProvider } from '../../providers/types';
import type { Approval, ApprovalCampaign, ApprovalEvent, ApprovalMessage, TasksApi } from '../../lib/tasksApi';
import { APPROVAL_STATUS_LABEL, KIND_LABEL, TasksError } from '../../lib/tasksApi';
import { isCampaign, runApproval } from '../../lib/approvalRun';
import { textToHtml } from '../../lib/html';
import { errorText } from '../Toast';
import { memberName, type Member } from './TaskForm';

type Scope = 'queue' | 'mine' | 'history';

interface Props {
  api: TasksApi;
  members: Member[];
  you: string;
  provider: MailProvider;
  profile: Profile;
  /** Outreach sequences waiting for an admin (they keep their own approval flow). */
  pendingSequences: number | null;
  onOpenSequences: () => void;
  initialId?: number;
  onChanged: () => void;
}

const when = (ms: number) => new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const people = (l: { name: string; email: string }[]) => l.map(p => (p.name && p.name !== p.email ? p.name + ' <' + p.email + '>' : p.email)).join(', ');
const tone = (s: Approval['status']) => (s === 'approved' || s === 'executed' ? ' ok' : s === 'rejected' || s === 'failed' ? ' danger' : s === 'pending' || s === 'deferred' ? ' warn' : '');

const ACTION_TEXT: Record<string, string> = {
  requested: 'asked for approval', approved: 'approved', rejected: 'rejected', deferred: 'deferred', edited: 'edited it',
  edited_after_approval: 'edited it after approval (approval no longer applies)', renamed: 'renamed it', executing: 'started sending',
  executed: 'sent it', failed: 'tried to send it; it failed', withdrawn: 'withdrew it'
};

export function ApprovalsTab({ api, members, you, provider, profile, pendingSequences, onOpenSequences, initialId, onChanged }: Props) {
  const [scope, setScope] = useState<Scope>('queue');
  const [list, setList] = useState<Approval[] | null>(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState<Approval | null>(null);

  const load = useCallback(() => {
    setList(null); setErr('');
    api.approvals(scope).then(setList).catch(e => setErr(errorText(e)));
  }, [api, scope]);
  useEffect(load, [load]);
  useEffect(() => {
    if (initialId) api.approval(initialId).then(setOpen).catch(e => setErr(errorText(e)));
  }, [api, initialId]);

  const changed = (a: Approval) => {
    setOpen(a);
    setList(l => l && l.map(x => (x.id === a.id ? a : x)));
    onChanged();
  };

  return (
    <>
      <div className="row-wrap" role="tablist" aria-label="Approvals">
        {([['queue', 'To review'], ['mine', 'My requests'], ['history', 'History']] as [Scope, string][]).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={scope === k} className={'btn sm' + (scope === k ? ' primary' : ' ghost')} onClick={() => { setScope(k); setOpen(null); }}>{l}</button>
        ))}
        <button className="btn ghost sm" aria-label="Refresh" style={{ marginLeft: 'auto' }} onClick={load}>↻</button>
      </div>
      {scope === 'queue' && pendingSequences != null && pendingSequences > 0 && (
        <div className="card panel"><div className="row-wrap" style={{ alignItems: 'center' }}>
          <span><b>{pendingSequences}</b> outreach sequence{pendingSequences === 1 ? '' : 's'} waiting for approval. Sequences are approved version by version in Outreach sequences.</span>
          <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={onOpenSequences}>Review sequences</button>
        </div></div>
      )}
      {err && <div className="notice warn" role="alert">{err}</div>}
      {open && <ApprovalPanel key={open.id} api={api} a={open} members={members} you={you} provider={provider} profile={profile} onChanged={changed} onClose={() => setOpen(null)} />}
      {!list && !err && <div className="card panel an-loading"><div className="spinner" /> Loading…</div>}
      {list && (list.length ? (
        <div className="card table table-scroll" aria-label="Approval requests">
          <div className="trow approvals head"><span>REQUEST</span><span>KIND</span><span>REQUESTED BY</span><span>STATUS</span><span>WHEN</span></div>
          {list.map(a => (
            <button key={a.id} className={'trow approvals link-like' + (open?.id === a.id ? ' on' : '')} onClick={() => setOpen(a)}>
              <span className="user-cell"><b>{a.title}</b><span>Version {a.version}{a.mailbox ? ' · ' + a.mailbox : ''}</span></span>
              <span className="muted">{KIND_LABEL[a.kind]}</span>
              <span className="muted">{memberName(members, a.requester)}</span>
              <span><span className={'pill' + tone(a.status)}>{APPROVAL_STATUS_LABEL[a.status]}</span></span>
              <span className="muted">{when(a.decidedAt || a.requestedAt)}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="card panel"><span className="faint">
          {scope === 'queue' ? 'Nothing is waiting for your review.' : scope === 'mine' ? 'You haven’t asked for any approvals. Ask from the composer, or when bulk email holds Investor and LP messages.' : 'No decisions yet.'}
        </span></div>
      ))}
    </>
  );
}

function ApprovalPanel({ api, a, members, you, provider, profile, onChanged, onClose }: {
  api: TasksApi; a: Approval; members: Member[]; you: string; provider: MailProvider; profile: Profile; onChanged: (a: Approval) => void; onClose: () => void;
}) {
  const [events, setEvents] = useState<ApprovalEvent[] | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [editing, setEditing] = useState(false);
  const [progress, setProgress] = useState<[number, number] | null>(null);

  useEffect(() => {
    let live = true;
    api.approvalEvents(a.id).then(e => live && setEvents(e)).catch(() => live && setEvents([]));
    return () => { live = false; };
  }, [api, a.id, a.version, a.status]);

  const act = async (label: string, f: () => Promise<void>) => {
    setBusy(label); setErr('');
    try { await f(); } catch (e) {
      if (e instanceof TasksError && e.code === 'approval_changed') {
        setErr('This request changed since you opened it. This is the current version: review it again.');
        onChanged(await api.approval(a.id));
      } else setErr(errorText(e));
    } finally { setBusy(''); }
  };

  const decide = (d: 'approve' | 'reject' | 'defer') => act(d, async () => {
    if (d === 'reject' && !note.trim()) { setErr('Say why, so the requester can fix it.'); return; }
    onChanged(await api.decide(a, d, note.trim()));
  });

  const send = () => act('send', async () => {
    const n = isCampaign(a.payload) ? a.payload.messages.length : 1;
    if (!window.confirm('Send ' + (n === 1 ? 'this message' : n + ' messages') + ' from ' + a.payload.identity.addr + ', exactly as approved (version ' + a.version + ')?')) return;
    const r = await runApproval(api, a, provider, profile, (done, total) => setProgress([done, total]));
    setProgress(null);
    onChanged(r.approval);
    if (r.failed.length) setErr(r.sent + ' sent, ' + r.failed.length + ' failed. Failed messages are not retried automatically: ' + r.failed.slice(0, 3).join('; '));
  });

  const p = a.payload;
  return (
    <div className="card panel task-panel" aria-label="Approval request">
      <div className="row-wrap" style={{ alignItems: 'center' }}>
        <b style={{ fontSize: 15 }}>{a.title}</b>
        <span className="pill">{KIND_LABEL[a.kind]}</span>
        <span className={'pill' + tone(a.status)}>{APPROVAL_STATUS_LABEL[a.status]}</span>
        <button className="btn ghost sm" style={{ marginLeft: 'auto' }} onClick={onClose}>Close</button>
      </div>
      <span className="muted" style={{ fontSize: 12.5 }}>
        Requested by {memberName(members, a.requester)} {when(a.requestedAt)} · version {a.version} · content <span className="mono" title={a.contentHash}>{a.contentHash.slice(0, 12)}</span>
        {a.reviewer ? ' · ' + (a.status === 'deferred' ? 'deferred' : a.status === 'rejected' ? 'rejected' : 'approved') + ' by ' + memberName(members, a.reviewer) : ''}
      </span>
      {a.note && <span className="notice accent">Reviewer’s note: {a.note}</span>}
      {a.result && <span className={'notice ' + (a.status === 'failed' ? 'danger' : 'accent')}>{a.result}</span>}
      {a.status === 'executing' && <span className="notice warn">Sending started {a.executedAt ? when(a.executedAt) : ''} and didn’t report back. Check Sent before doing anything else; it won’t be sent again from here.</span>}
      {err && <div className="notice warn" role="alert">{err}</div>}

      {editing
        ? <EditPayload a={a} busy={busy === 'edit'} onCancel={() => setEditing(false)} onSave={payload => act('edit', async () => {
          onChanged(await api.editApproval(a, payload));
          setEditing(false);
        })} />
        : isCampaign(p) ? <CampaignView p={p} /> : <MessageView p={p} />}

      {!editing && (
        <>
          {a.canReview && (
            <>
              <label className="tf-field">Note to the requester (needed to reject)
                <textarea className="textarea" rows={2} value={note} onChange={e => setNote(e.target.value)} maxLength={1000} />
              </label>
              <div className="row-wrap">
                <button className="btn primary sm" disabled={!!busy} onClick={() => decide('approve')}>{busy === 'approve' ? 'Approving…' : 'Approve version ' + a.version}</button>
                <button className="btn sm danger" disabled={!!busy} onClick={() => decide('reject')}>Reject</button>
                {a.status !== 'deferred' && <button className="btn ghost sm" disabled={!!busy} onClick={() => decide('defer')}>Defer</button>}
              </div>
            </>
          )}
          <div className="row-wrap">
            {a.canExecute && <button className="btn primary sm" disabled={!!busy} onClick={send}>{progress ? 'Sending ' + progress[0] + ' of ' + progress[1] + '…' : 'Send as approved'}</button>}
            {a.canEdit && <button className="btn sm" disabled={!!busy} onClick={() => setEditing(true)}>Edit{a.status === 'approved' ? ' (needs approval again)' : ''}</button>}
            {a.requester === you && ['pending', 'deferred', 'approved', 'rejected'].includes(a.status) && (
              <button className="btn ghost sm" disabled={!!busy} onClick={() => { if (window.confirm('Withdraw this request?')) act('withdraw', async () => onChanged(await api.withdraw(a.id))); }}>Withdraw</button>
            )}
          </div>
          {a.status === 'approved' && !a.canExecute && (
            <span className="faint" style={{ fontSize: 12 }}>{a.kind === 'shared_reply' ? 'A member who can send from ' + a.mailbox + ' sends it.' : memberName(members, a.requester) + ' sends it from their mailbox.'}</span>
          )}
        </>
      )}

      <div className="task-section" aria-label="Request history">
        <span className="mono-label">History</span>
        {!events ? <span className="faint">Loading…</span> : events.map((e, i) => (
          <span key={i} style={{ fontSize: 12.5 }}>
            <b>{memberName(members, e.actor)}</b> {ACTION_TEXT[e.action] || e.action} <span className="faint">· version {e.version} · <span className="mono">{e.contentHash.slice(0, 8)}</span> · {when(e.at)}</span>
            {e.note ? <span className="muted"> — {e.note}</span> : null}
          </span>
        ))}
      </div>
    </div>
  );
}

function MessageView({ p }: { p: ApprovalMessage }) {
  return (
    <div className="approval-msg">
      <div className="kv-row"><span className="mono-key">FROM</span><span>{p.identity.name} &lt;{p.identity.addr}&gt;</span></div>
      <div className="kv-row"><span className="mono-key">TO</span><span>{people(p.to)}</span></div>
      {p.cc.length > 0 && <div className="kv-row"><span className="mono-key">CC</span><span>{people(p.cc)}</span></div>}
      {p.bcc.length > 0 && <div className="kv-row"><span className="mono-key">BCC</span><span>{people(p.bcc)}</span></div>}
      <div className="kv-row"><span className="mono-key">SUBJECT</span><span>{p.subject || '(no subject)'}</span></div>
      {p.reply && <div className="kv-row"><span className="mono-key">REPLY</span><span>In an existing conversation</span></div>}
      {/* The text version, so nothing in the message is rendered as HTML here. */}
      <pre className="approval-body">{p.text}</pre>
    </div>
  );
}

function CampaignView({ p }: { p: ApprovalCampaign }) {
  const [shown, setShown] = useState(0);
  const m = p.messages[shown];
  return (
    <div className="approval-msg">
      <div className="kv-row"><span className="mono-key">FROM</span><span>{p.identity.name} &lt;{p.identity.addr}&gt;</span></div>
      <div className="kv-row"><span className="mono-key">TO</span><span>{p.messages.length} recipient{p.messages.length === 1 ? '' : 's'}, one message each{p.optout ? ' · opt-out line added' : ''}</span></div>
      <select className="input" aria-label="Preview message for" value={shown} onChange={e => setShown(Number(e.target.value))}>
        {p.messages.map((x, i) => <option key={i} value={i}>{x.to.name || x.to.email} · {x.to.email}{x.persona ? ' · ' + x.persona : ''}</option>)}
      </select>
      {m && (
        <>
          <div className="kv-row"><span className="mono-key">SUBJECT</span><span>{m.subject}</span></div>
          <pre className="approval-body">{m.text}</pre>
        </>
      )}
    </div>
  );
}

function EditPayload({ a, busy, onSave, onCancel }: { a: Approval; busy: boolean; onSave: (p: ApprovalMessage | ApprovalCampaign) => void; onCancel: () => void }) {
  const p = a.payload;
  const [subject, setSubject] = useState(isCampaign(p) ? '' : p.subject);
  const [text, setText] = useState(isCampaign(p) ? '' : p.text);
  const [msgs, setMsgs] = useState(isCampaign(p) ? p.messages : []);
  const [i, setI] = useState(0);

  if (isCampaign(p)) {
    const m = msgs[i];
    const set = (patch: Partial<ApprovalCampaign['messages'][number]>) => setMsgs(l => l.map((x, k) => (k === i ? { ...x, ...patch } : x)));
    return (
      <div className="task-form">
        <span className="notice warn">Any change is a new version: it needs approval again before it can be sent.</span>
        <select className="input" aria-label="Message" value={i} onChange={e => setI(Number(e.target.value))}>
          {msgs.map((x, k) => <option key={k} value={k}>{x.to.name || x.to.email} · {x.to.email}</option>)}
        </select>
        {m && (
          <>
            <label className="tf-field">Subject<input className="input" value={m.subject} onChange={e => set({ subject: e.target.value })} /></label>
            <label className="tf-field">Message<textarea className="textarea" rows={8} value={m.text} onChange={e => set({ text: e.target.value })} /></label>
            <button className="btn ghost sm danger" disabled={msgs.length < 2} onClick={() => { setMsgs(l => l.filter((_, k) => k !== i)); setI(0); }}>Remove this recipient</button>
          </>
        )}
        <div className="row-wrap">
          <button className="btn primary sm" disabled={busy} onClick={() => onSave({ ...p, messages: msgs })}>{busy ? 'Saving…' : 'Save new version'}</button>
          <button className="btn ghost sm" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    );
  }
  return (
    <div className="task-form">
      <span className="notice warn">Any change is a new version: it needs approval again before it can be sent. Editing here makes the message plain text.</span>
      <label className="tf-field">Subject<input className="input" value={subject} onChange={e => setSubject(e.target.value)} /></label>
      <label className="tf-field">Message<textarea className="textarea" rows={10} value={text} onChange={e => setText(e.target.value)} /></label>
      <div className="row-wrap">
        <button className="btn primary sm" disabled={busy} onClick={() => onSave({ ...p, subject, text, html: text === p.text ? p.html : textToHtml(text) })}>{busy ? 'Saving…' : 'Save new version'}</button>
        <button className="btn ghost sm" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
