import { useCallback, useEffect, useMemo, useState } from 'react';
import { renderIssue, SAMPLE_RECIPIENT, TEMPLATE_NAME, isTestingTemplate } from '../../lib/newsletter/render';
import type { Issue, NewslettersApi, NlList, NlSettings } from '../../lib/newslettersApi';
import { errorText } from '../Toast';
import { Preview } from './Preview';

const ago = (t: number) => { const m = Math.round((Date.now() - t) / 60000); return m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' d ago'; };
const when = (t: number | null) => (t ? new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');

/** Newsletters and testing emails waiting for a decision (N3), inside Tasks & Approvals. */
export function NewsletterApprovals({ api, you, onChanged }: { api: NewslettersApi; you: string; onChanged?: () => void }) {
  const [queue, setQueue] = useState<Issue[] | null>(null);
  const [lists, setLists] = useState<NlList[]>([]);
  const [settings, setSettings] = useState<NlSettings | null>(null);
  const [open, setOpen] = useState<Issue | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(() => {
    api.overview({ scope: 'review' }).then(r => { setQueue(r.issues); setLists(r.lists); }).catch(() => setQueue([]));
    api.settings().then(setSettings).catch(() => {});
  }, [api]);
  useEffect(load, [load]);
  const pick = (i: Issue) => { setErr(''); setReason(''); api.get(i.id).then(r => setOpen(r.issue)).catch(e => setErr(errorText(e))); };
  useEffect(() => { if (queue?.length && !open) pick(queue[0]); }, [queue]); // eslint-disable-line react-hooks/exhaustive-deps

  const rendered = useMemo(() => open ? renderIssue({
    content: { template: open.template, subject: open.subject, preheader: open.preheader, blocks: open.blocks || [] }, edition: open.edition,
    brand: { fromName: settings?.fromName || 'Axal VC', postalAddress: settings?.postalAddress || '', disclaimer: settings?.disclaimer || '' }, recipient: SAMPLE_RECIPIENT,
    sender: { name: open.fromName || 'Axal VC', title: open.signoff.title, email: open.fromEmail, calendarUrl: open.signoff.calendarUrl }
  }) : { html: '', text: '' }, [open, settings]);

  if (!queue || !queue.length) return null;

  const decide = async (action: 'approve' | 'reject' | 'defer') => {
    if (!open) return;
    if (action !== 'approve' && !reason.trim()) { setErr('Give a reason to reject or defer.'); return; }
    setBusy(true); setErr('');
    try {
      await api.action(open.id, action, { version: open.version, contentHash: open.contentHash, note: reason });
      setOpen(null); load(); onChanged?.();
    } catch (e) { setErr(errorText(e)); } finally { setBusy(false); }
  };
  const audience = open ? [...open.listIds.map(id => lists.find(l => l.id === id)?.name).filter(Boolean), ...open.audiences.map(k => (k.startsWith('testers:') ? 'Picked testers' : k))].join(' · ') : '';
  const mine = open && (open.reviewRequestedBy === you || open.updatedBy === you);

  return (
    <div className="nl-approvals">
      <div className="card panel nl-queue">
        <div className="row-wrap" style={{ alignItems: 'center' }}><span className="mono-label">Waiting for a decision</span><span className="pill warn">{queue.length}</span></div>
        {queue.map(i => (
          <button key={i.id} className={'nl-queue-item' + (open?.id === i.id ? ' on' : '')} onClick={() => pick(i)}>
            <span className="row-wrap" style={{ justifyContent: 'space-between' }}><span className="mono-label">{isTestingTemplate(i.template) ? 'Testing email' : 'Newsletter'}</span><span className="faint">{ago(i.updatedAt)}</span></span>
            <b>{i.title}</b>
            <span className="faint">Requested by {(i.reviewRequestedBy || i.createdBy).split('@')[0]} · Version {i.version}</span>
            {i.lastError?.startsWith('Changed after approval') && <span className="pill warn" style={{ alignSelf: 'flex-start' }}>Changed after approval, needs approval again</span>}
          </button>
        ))}
      </div>
      {open && (
        <div className="card panel nl-approval">
          <span className="mono-label">{isTestingTemplate(open.template) ? 'Testing email approval' : 'Newsletter approval'}</span>
          <div className="row-wrap" style={{ alignItems: 'center' }}><h3>{open.title}</h3><span className="pill warn">Awaiting approval</span></div>
          <span className="faint">Requested by {open.reviewRequestedBy || open.createdBy} · {when(open.updatedAt)} · {TEMPLATE_NAME[open.template]}</span>
          <div className="nl-facts">
            <div><span className="mono-label">Version</span><b>{open.version}</b></div>
            <div><span className="mono-label">Content hash</span><b title={open.contentHash}>{open.contentHash.slice(0, 4)}…{open.contentHash.slice(-4)}</b><span className="faint">Subject, content, audience and sender</span></div>
            <div><span className="mono-label">Audience</span><b>{open.audience !== undefined && !open.audiences.length ? open.audience + ' people' : audience ? 'Read when sending' : '—'}</b><span className="faint">{audience || 'No audience chosen'}</span></div>
            <div><span className="mono-label">From</span><b>{open.fromEmail || '(the scheduler’s address)'}</b></div>
          </div>
          <Preview html={rendered.html} text={rendered.text} />
          <div className="notice accent">Approving sends exactly this version. Any edit needs approval again.</div>
          {open.lastError && <div className="notice warn">{open.lastError}</div>}
          <span className="mono-label">Decision</span>
          <textarea className="textarea" rows={2} placeholder="Reason (needed to reject or defer)" value={reason} onChange={e => setReason(e.target.value)} />
          {err && <span className="tone-danger">{err}</span>}
          <div className="row-wrap">
            <button className="btn primary sm" disabled={busy || !open.canApprove} onClick={() => decide('approve')}>Approve version {open.version}</button>
            <button className="btn sm danger" disabled={busy || !open.canApprove && !mine} onClick={() => decide('reject')}>Reject</button>
            <button className="btn sm" disabled={busy} onClick={() => decide('defer')}>Defer</button>
          </div>
          {!open.canApprove && <span className="faint">{mine ? 'You can’t approve your own request: another admin does.' : 'Only an admin approves.'}</span>}
          <span className="faint">The decision, reason and content hash are kept in the audit log.</span>
        </div>
      )}
    </div>
  );
}
