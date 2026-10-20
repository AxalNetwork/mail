import { useEffect, useMemo, useState } from 'react';
import type { Block, BlockType } from '../../lib/newsletter/types';
import { BLOCK_LABEL } from '../../lib/newsletter/types';
import { renderIssue, SAMPLE_RECIPIENT, TEMPLATE_NAME } from '../../lib/newsletter/render';
import { emptyBlock, placeholders } from '../../lib/newsletter/templates';
import type { Issue, IssueChange, NewslettersApi, NlList, NlSettings } from '../../lib/newslettersApi';
import { NewslettersError, STATUS_LABEL } from '../../lib/newslettersApi';
import { errorText } from '../Toast';
import { BlockForm } from './BlockForm';

type View = 'desktop' | 'mobile' | 'dark' | 'noimg' | 'text';
const TOKENS = ['{first_name}', '{last_name}', '{company|your team}', '{sender_name}', '{sender_title}', '{calendar_url}'];
const ADDABLE: BlockType[] = ['text', 'note', 'essay', 'items', 'events', 'hero', 'quote', 'image', 'button', 'callout', 'tags', 'divider'];

interface Props {
  api: NewslettersApi;
  id: number;
  lists: NlList[];
  settings: NlSettings | null;
  you: { email: string; name: string };
  canManage: boolean;
  canAssist: boolean;
  onClose: () => void;
  onChanged: (i: Issue | null) => void;
  toast: (text: string, error?: boolean) => void;
}

const when = (t: number | null) => (t ? new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');

export function IssueEditor({ api, id, lists, settings, you, canManage, canAssist, onClose, onChanged, toast }: Props) {
  const [issue, setIssue] = useState<Issue | null>(null);
  const [checks, setChecks] = useState<string[]>([]);
  const [draft, setDraft] = useState<IssueChange & { blocks: Block[] }>({ blocks: [] });
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [view, setView] = useState<View>('desktop');
  const [openBlock, setOpenBlock] = useState<string | null>(null);
  const [at, setAt] = useState('');
  const [rejectNote, setRejectNote] = useState<string | null>(null);
  const [subjects, setSubjects] = useState<string[]>([]);
  const [failures, setFailures] = useState<{ email: string; error: string }[] | null>(null);

  const adopt = (i: Issue, c?: string[]) => {
    setIssue(i);
    if (c) setChecks(c);
    setDraft({ title: i.title, subject: i.subject, preheader: i.preheader, edition: i.edition, listIds: i.listIds, fromEmail: i.fromEmail, fromName: i.fromName, signoff: i.signoff, blocks: i.blocks || [] });
    setDirty(false);
  };
  const reload = () => api.get(id).then(r => { adopt(r.issue, r.checks); onChanged(r.issue); }).catch(e => setErr(errorText(e)));
  useEffect(() => { api.get(id).then(r => adopt(r.issue, r.checks)).catch(e => setErr(errorText(e))); }, [api, id]);

  const editable = !!issue?.canEdit;
  const change = (patch: Partial<typeof draft>) => { setDraft(d => ({ ...d, ...patch })); setDirty(true); };
  const setBlock = (i: number, b: Block) => change({ blocks: draft.blocks.map((x, j) => (j === i ? b : x)) });
  const move = (i: number, by: number) => {
    const l = [...draft.blocks];
    const j = i + by;
    if (j < 0 || j >= l.length) return;
    [l[i], l[j]] = [l[j], l[i]];
    change({ blocks: l });
  };

  const html = useMemo(() => {
    if (!issue) return { html: '', text: '' };
    const out = renderIssue({
      content: { template: issue.template, subject: draft.subject || '', preheader: draft.preheader || '', blocks: draft.blocks },
      edition: draft.edition || '',
      brand: { fromName: settings?.fromName || 'Axal VC', postalAddress: settings?.postalAddress || '[Postal address: set it in Settings]', disclaimer: settings?.disclaimer || '' },
      recipient: SAMPLE_RECIPIENT,
      sender: { name: draft.fromName || you.name, title: draft.signoff?.title || '', email: draft.fromEmail || you.email, calendarUrl: draft.signoff?.calendarUrl || '' }
    });
    let h = out.html;
    if (view === 'dark') h = h.replace('@media (prefers-color-scheme:dark){', '@media all{');
    if (view === 'noimg') h = h.replace(/<img\b[^>]*>/g, '');
    return { html: h, text: out.text };
  }, [issue, draft, settings, you, view]);

  const save = async (): Promise<Issue | null> => {
    if (!issue) return null;
    if (!dirty) return issue;
    setBusy('save'); setErr('');
    try {
      const i = await api.update(issue.id, issue.version, draft);
      const r = await api.get(i.id);
      adopt(r.issue, r.checks);
      onChanged(r.issue);
      return r.issue;
    } catch (e) {
      if (e instanceof NewslettersError && e.code === 'issue_conflict') setErr('Someone saved this newsletter first. Copy your changes, then reload.');
      else setErr(errorText(e));
      return null;
    } finally { setBusy(''); }
  };

  const act = async (name: 'review' | 'approve' | 'reject' | 'schedule' | 'cancel' | 'resume' | 'duplicate', extra: Record<string, unknown> = {}) => {
    const cur = await save();
    if (!cur) return;
    setBusy(name); setErr('');
    try {
      const i = await api.action(cur.id, name, { version: cur.version, contentHash: cur.contentHash, ...extra });
      if (name === 'duplicate') { toast('Copy created: ' + i.title); onChanged(i); return; }
      const r = await api.get(i.id);
      adopt(r.issue, r.checks);
      onChanged(r.issue);
      toast({ review: 'Sent for approval.', approve: 'Approved.', reject: 'Sent back to the author.', schedule: 'Scheduled. The Worker sends it in batches.', cancel: 'Stopped.', resume: 'Resumed.' }[name]);
    } catch (e) {
      const problems = e instanceof NewslettersError && Array.isArray(e.body.problems) ? (e.body.problems as string[]) : null;
      if (problems) setChecks(problems);
      setErr(errorText(e));
    } finally { setBusy(''); }
  };

  const assist = async (mode: 'subjects' | 'draft' | 'shorten', text: string, apply?: (t: string) => void) => {
    if (!issue) return;
    setBusy('assist'); setErr('');
    try {
      const r = await api.assist({ mode, text: text || draft.blocks.map(b => ('text' in b ? b.text : '')).join('\n\n').slice(0, 8000), subject: draft.subject, template: issue.template });
      if (mode === 'subjects') setSubjects(r.subjects);
      else if (apply && r.text) apply(r.text);
      if (r.note) toast('Assistant: ' + r.note);
    } catch (e) { setErr(errorText(e)); } finally { setBusy(''); }
  };

  if (!issue) {
    return <div className="card panel">{err ? <span className="tone-danger">{err}</span> : <span className="an-loading"><span className="spinner" /> Loading…</span>}</div>;
  }

  const left = placeholders(draft.blocks, draft.subject || '', draft.preheader || '');
  const status = issue.status;
  const progress = issue.recipients ? Math.round(((issue.sent + issue.failed + issue.skipped) / issue.recipients) * 100) : 0;

  return (
    <div className="nl-editor">
      <div className="nl-editor-head">
        <button className="btn ghost sm" onClick={async () => { if (!dirty || window.confirm('Leave without saving your changes?')) onClose(); }}>← Newsletters</button>
        <input className="input nl-title" aria-label="Newsletter title" value={draft.title || ''} disabled={!editable} maxLength={120} onChange={e => change({ title: e.target.value })} />
        <span className={'pill' + (status === 'sent' ? ' ok' : status === 'in_review' || status === 'paused' ? ' warn' : status === 'approved' || status === 'scheduled' || status === 'sending' ? ' accent' : '')}>
          {STATUS_LABEL[status]}{status === 'scheduled' && issue.scheduledAt ? ' · ' + when(issue.scheduledAt) : ''}
        </span>
        <span className="faint">{TEMPLATE_NAME[issue.template]} · v{issue.version}</span>
        <span style={{ flex: 1 }} />
        {editable && <button className="btn primary sm" disabled={!dirty || !!busy} onClick={save}>{busy === 'save' ? 'Saving…' : dirty ? 'Save' : 'Saved'}</button>}
      </div>

      {err && <div className="notice danger" role="alert">{err} <button className="link-btn" onClick={reload}>Reload</button></div>}
      {issue.lastError && <div className="notice warn">{issue.lastError}</div>}

      <div className="nl-cols">
        <div className="nl-form">
          <div className="card panel">
            <span className="mono-label">Envelope</span>
            <label className="nl-field"><span>Subject <em className={(draft.subject || '').length > 60 ? 'tone-danger' : 'faint'}>{(draft.subject || '').length}/60</em></span>
              <input className="input" value={draft.subject || ''} maxLength={200} disabled={!editable} onChange={e => change({ subject: e.target.value })} />
            </label>
            {canAssist && editable && (
              <span className="row-wrap">
                <button className="link-btn" disabled={!!busy} onClick={() => assist('subjects', '')}>{busy === 'assist' ? 'Thinking…' : 'Suggest subject lines'}</button>
              </span>
            )}
            {subjects.length > 0 && (
              <div className="row-wrap">{subjects.map(s => <button key={s} className="btn soft sm" onClick={() => { change({ subject: s }); setSubjects([]); }}>{s}</button>)}</div>
            )}
            <label className="nl-field"><span>Preview text <em className={(draft.preheader || '').length > 90 ? 'tone-danger' : 'faint'}>{(draft.preheader || '').length}/90</em></span>
              <input className="input" value={draft.preheader || ''} maxLength={200} disabled={!editable} onChange={e => change({ preheader: e.target.value })} />
            </label>
            <label className="nl-field"><span>Edition</span>
              <input className="input" value={draft.edition || ''} maxLength={60} placeholder="No. 14 · October 2026" disabled={!editable} onChange={e => change({ edition: e.target.value })} />
            </label>
            <div className="row-wrap">
              <label className="nl-field" style={{ flex: '1 1 160px' }}><span>From name</span>
                <input className="input" value={draft.fromName || ''} placeholder={settings?.fromName || 'Axal VC'} maxLength={80} disabled={!editable} onChange={e => change({ fromName: e.target.value })} />
              </label>
              <label className="nl-field" style={{ flex: '1 1 200px' }}><span>From address</span>
                <input className="input" value={draft.fromEmail || ''} placeholder="Your address, or a verified alias" maxLength={254} disabled={!editable} onChange={e => change({ fromEmail: e.target.value })} />
              </label>
            </div>
            {issue.template === 'letter' || issue.template === 'founder' ? (
              <div className="row-wrap">
                <label className="nl-field" style={{ flex: '1 1 160px' }}><span>Sender title</span>
                  <input className="input" value={draft.signoff?.title || ''} maxLength={100} disabled={!editable} onChange={e => change({ signoff: { title: e.target.value, calendarUrl: draft.signoff?.calendarUrl || '' } })} />
                </label>
                <label className="nl-field" style={{ flex: '1 1 200px' }}><span>Calendar link</span>
                  <input className="input" value={draft.signoff?.calendarUrl || ''} placeholder="https://" maxLength={600} disabled={!editable} onChange={e => change({ signoff: { title: draft.signoff?.title || '', calendarUrl: e.target.value } })} />
                </label>
              </div>
            ) : null}
            <span className="faint" style={{ fontSize: 11.5 }}>Merge tokens: {TOKENS.map(t => <code key={t} className="nl-token">{t}</code>)}</span>
          </div>

          <div className="card panel">
            <span className="mono-label">Audience</span>
            {lists.map(l => (
              <label key={l.id} className="check-row">
                <input type="checkbox" disabled={!editable} checked={(draft.listIds || []).includes(l.id)}
                  onChange={e => change({ listIds: e.target.checked ? [...(draft.listIds || []), l.id] : (draft.listIds || []).filter(x => x !== l.id) })} />
                <span>{l.name} <span className="faint">· {l.subscribed} subscribed</span></span>
                {l.requiresApproval && <span className="pill warn">Needs approval</span>}
                {!l.public && <span className="pill">Private</span>}
              </label>
            ))}
            {!dirty && issue.audience !== undefined && (
              <span className="muted">
                {issue.audience} will receive it
                {issue.excluded && (issue.excluded.unsubscribed + issue.excluded.bounced + issue.excluded.pending) > 0
                  ? ` · not sent to ${issue.excluded.unsubscribed} unsubscribed, ${issue.excluded.bounced} bounced, ${issue.excluded.pending} unconfirmed` : ''}
              </span>
            )}
          </div>

          <div className="card panel">
            <span className="mono-label">Content</span>
            {draft.blocks.map((b, i) => (
              <div key={b.id} className={'nl-block' + (openBlock === b.id ? ' open' : '')}>
                <div className="nl-block-head">
                  <button className="link-like nl-block-name" onClick={() => setOpenBlock(openBlock === b.id ? null : b.id)}>
                    <b>{BLOCK_LABEL[b.type]}</b>
                    <span className="faint">{'label' in b && b.label ? b.label : 'title' in b && b.title ? b.title : 'text' in b ? b.text.slice(0, 60) : ''}</span>
                  </button>
                  {editable && (
                    <span className="nl-block-tools">
                      <button className="btn ghost sm" aria-label="Move up" disabled={!i} onClick={() => move(i, -1)}>↑</button>
                      <button className="btn ghost sm" aria-label="Move down" disabled={i === draft.blocks.length - 1} onClick={() => move(i, 1)}>↓</button>
                      <button className="btn ghost sm danger" aria-label="Remove section" onClick={() => change({ blocks: draft.blocks.filter((_, j) => j !== i) })}>✕</button>
                    </span>
                  )}
                </div>
                {openBlock === b.id && (
                  <div className="nl-block-body">
                    <BlockForm block={b} disabled={!editable} onChange={x => setBlock(i, x)} onAssist={canAssist ? (mode, text, apply) => assist(mode, text, apply) : undefined} />
                  </div>
                )}
              </div>
            ))}
            {editable && (
              <select className="input" aria-label="Add a section" value="" onChange={e => {
                if (!e.target.value) return;
                const b = emptyBlock(e.target.value as BlockType);
                change({ blocks: [...draft.blocks, b] });
                setOpenBlock(b.id);
              }}>
                <option value="">+ Add a section…</option>
                {ADDABLE.map(t => <option key={t} value={t}>{BLOCK_LABEL[t]}</option>)}
              </select>
            )}
          </div>

          <div className="card panel">
            <span className="mono-label">Before sending</span>
            {dirty && <span className="muted">Save to run the checks.</span>}
            {!dirty && (checks.length ? checks.map(c => <span key={c} className="tone-danger">✕ {c}</span>) : <span className="tone-ok">✓ Ready to send</span>)}
            {left.length > 0 && <span className="muted">Placeholders left: {left.join(', ')}</span>}
            {issue.approvalRequired && <span className="muted">{issue.approved ? '✓ Approved by ' + issue.approvedBy + ' (this version)' : 'This audience needs an admin’s approval of this exact version.'}</span>}
          </div>

          {['sending', 'sent', 'paused'].includes(status) && (
            <div className="card panel">
              <span className="mono-label">Sending</span>
              <div className="nl-progress"><span style={{ width: progress + '%' }} /></div>
              <span className="muted">{issue.sent} accepted by Gmail · {issue.failed} failed · {issue.skipped} skipped · {issue.queued} waiting · of {issue.recipients}</span>
              {issue.unsubscribes ? <span className="muted">{issue.unsubscribes} unsubscribed from this issue</span> : null}
              <span className="faint">Delivery is unknown: Gmail confirms acceptance only. Opens and clicks aren’t tracked.</span>
              {issue.failed > 0 && <button className="link-btn" onClick={() => api.report(issue.id).then(r => setFailures(r.failures)).catch(e => setErr(errorText(e)))}>Show failures</button>}
              {failures && failures.map(f => <span key={f.email} className="faint">{f.email}: {f.error}</span>)}
            </div>
          )}

          <div className="card panel nl-actions">
            {status === 'draft' && <button className="btn sm" disabled={!!busy} onClick={() => act('review')}>Request approval</button>}
            {issue.canApprove && <button className="btn primary sm" disabled={!!busy || dirty} onClick={() => act('approve')}>Approve this version</button>}
            {canManage && status === 'in_review' && rejectNote === null && <button className="btn sm" onClick={() => setRejectNote('')}>Send back</button>}
            {rejectNote !== null && (
              <span className="row-wrap" style={{ width: '100%' }}>
                <input className="input" style={{ flex: 1 }} placeholder="What should change?" value={rejectNote} onChange={e => setRejectNote(e.target.value)} />
                <button className="btn sm" disabled={!rejectNote.trim()} onClick={() => act('reject', { note: rejectNote }).then(() => setRejectNote(null))}>Send back</button>
                <button className="btn ghost sm" onClick={() => setRejectNote(null)}>Cancel</button>
              </span>
            )}
            {canManage && <button className="btn sm" disabled={!!busy} onClick={async () => {
              const cur = await save(); if (!cur) return;
              setBusy('test');
              api.test(cur.id).then(r => toast('Test sent to ' + r.to)).catch(e => setErr(errorText(e))).finally(() => setBusy(''));
            }}>{busy === 'test' ? 'Sending…' : 'Send a test to me'}</button>}
            {issue.canSchedule && (
              <span className="row-wrap" style={{ alignItems: 'center' }}>
                <input className="input" type="datetime-local" aria-label="Send at" value={at} onChange={e => setAt(e.target.value)} />
                <button className="btn primary sm" disabled={!!busy || checks.length > 0 || dirty} onClick={() => {
                  const t = at ? new Date(at).getTime() : null;
                  if (window.confirm(t ? 'Schedule for ' + new Date(t).toLocaleString() + ' to ' + (issue.audience ?? 0) + ' people?' : 'Send now to ' + (issue.audience ?? 0) + ' people?')) act('schedule', { at: t });
                }}>{at ? 'Schedule' : 'Send now'}</button>
              </span>
            )}
            {canManage && (status === 'scheduled' || status === 'sending') && <button className="btn sm danger" disabled={!!busy} onClick={() => act('cancel')}>{status === 'sending' ? 'Pause sending' : 'Cancel schedule'}</button>}
            {canManage && status === 'paused' && <button className="btn sm" disabled={!!busy} onClick={() => act('resume')}>Resume</button>}
            <button className="btn ghost sm" disabled={!!busy} onClick={() => act('duplicate')}>Duplicate</button>
            {['draft', 'in_review', 'cancelled'].includes(status) && (issue.createdBy === you.email || canManage) && (
              <button className="btn ghost sm danger" disabled={!!busy} onClick={() => {
                if (window.confirm('Delete this newsletter?')) api.remove(issue.id).then(() => { onChanged(null); onClose(); }).catch(e => setErr(errorText(e)));
              }}>Delete</button>
            )}
            {!canManage && <span className="faint">An admin approves and sends.</span>}
          </div>
        </div>

        <div className="nl-preview card">
          <div className="seg" role="tablist" aria-label="Preview">
            {([['desktop', 'Desktop'], ['mobile', 'Mobile'], ['dark', 'Dark'], ['noimg', 'Images off'], ['text', 'Plain text']] as [View, string][]).map(([k, l]) => (
              <button key={k} role="tab" aria-selected={view === k} className={view === k ? 'on' : ''} onClick={() => setView(k)}>{l}</button>
            ))}
          </div>
          <span className="faint" style={{ fontSize: 11.5 }}>Preview for a sample reader ({SAMPLE_RECIPIENT.firstName} {SAMPLE_RECIPIENT.lastName}, {SAMPLE_RECIPIENT.company}).</span>
          {view === 'text'
            ? <pre className="nl-text">{html.text}</pre>
            : <iframe title="Newsletter preview" className={'nl-frame' + (view === 'mobile' ? ' mobile' : '')} sandbox="" srcDoc={html.html} />}
        </div>
      </div>
    </div>
  );
}
