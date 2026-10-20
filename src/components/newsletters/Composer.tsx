import { useEffect, useMemo, useState } from 'react';
import type { Block, BlockType } from '../../lib/newsletter/types';
import { BLOCK_LABEL } from '../../lib/newsletter/types';
import { renderIssue, SAMPLE_RECIPIENT, TEMPLATE_NAME, isTestingTemplate } from '../../lib/newsletter/render';
import { emptyBlock, placeholders, templateDef } from '../../lib/newsletter/templates';
import type { Issue, IssueChange, LinkAudience, NewslettersApi, NlList, NlSettings } from '../../lib/newslettersApi';
import { NewslettersError, statusPill } from '../../lib/newslettersApi';
import { errorText } from '../Toast';
import { BlockForm } from './BlockForm';
import { Preview } from './Preview';

const ADDABLE: BlockType[] = ['text', 'note', 'essay', 'items', 'events', 'hero', 'quote', 'image', 'button', 'callout', 'tags', 'divider'];
const when = (t: number | null) => (t ? new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const sectionName = (b: Block) => ('label' in b && b.label) || ('heading' in b && b.heading) || BLOCK_LABEL[b.type];

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
  onOpen: (id: number) => void;
  toast: (text: string, error?: boolean) => void;
}

type Draft = IssueChange & { blocks: Block[]; listIds: number[]; audiences: string[] };

export function Composer({ api, id, lists, settings, you, canManage, canAssist, onClose, onChanged, onOpen, toast }: Props) {
  const [issue, setIssue] = useState<Issue | null>(null);
  const [checks, setChecks] = useState<string[]>([]);
  const [draft, setDraft] = useState<Draft>({ blocks: [], listIds: [], audiences: [] });
  const [dirty, setDirty] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [step, setStep] = useState(2);
  const [link, setLink] = useState<{ configured: boolean; error: string | null; audiences: LinkAudience[]; at: number } | null>(null);
  const [senders, setSenders] = useState<{ email: string; name: string }[]>([]);
  const [assist, setAssist] = useState<{ text: string; apply: (t: string) => void; result: string; note: string } | null>(null);
  const [subjects, setSubjects] = useState<string[]>([]);
  const [sched, setSched] = useState({ date: '', time: '' });

  const adopt = (i: Issue, c?: string[]) => {
    setIssue(i);
    if (c) setChecks(c);
    setDraft({ title: i.title, subject: i.subject, preheader: i.preheader, edition: i.edition, listIds: i.listIds, audiences: i.audiences, fromEmail: i.fromEmail, fromName: i.fromName, signoff: i.signoff, blocks: i.blocks || [] });
    setDirty(false);
  };
  const reload = () => api.get(id).then(r => { adopt(r.issue, r.checks); onChanged(r.issue); }).catch(e => setErr(errorText(e)));
  useEffect(() => { api.get(id).then(r => { adopt(r.issue, r.checks); if (r.issue.status === 'approved' || r.issue.status === 'scheduled') setStep(4); }).catch(e => setErr(errorText(e))); }, [api, id]);
  useEffect(() => { api.senders().then(r => setSenders(r.addresses)).catch(() => {}); }, [api]);
  const loadLink = () => { setLink(null); api.linkAudiences().then(r => setLink({ ...r, at: Date.now() })).catch(e => setLink({ configured: true, error: errorText(e), audiences: [], at: Date.now() })); };
  useEffect(loadLink, [api]);

  const editable = !!issue?.canEdit;
  const change = (patch: Partial<Draft>) => { setDraft(d => ({ ...d, ...patch })); setDirty(true); };
  const setBlock = (i: number, b: Block) => change({ blocks: draft.blocks.map((x, j) => (j === i ? b : x)) });
  const move = (i: number, by: number) => {
    const l = [...draft.blocks]; const j = i + by;
    if (j < 0 || j >= l.length) return;
    [l[i], l[j]] = [l[j], l[i]];
    change({ blocks: l });
  };

  const rendered = useMemo(() => issue ? renderIssue({
    content: { template: issue.template, subject: draft.subject || '', preheader: draft.preheader || '', blocks: draft.blocks },
    edition: draft.edition || '',
    brand: { fromName: settings?.fromName || 'Axal VC', postalAddress: settings?.postalAddress || '[Postal address: set it in Newsletter settings]', disclaimer: settings?.disclaimer || '' },
    recipient: SAMPLE_RECIPIENT,
    sender: { name: draft.fromName || you.name, title: draft.signoff?.title || '', email: draft.fromEmail || you.email, calendarUrl: draft.signoff?.calendarUrl || '' }
  }) : { html: '', text: '' }, [issue, draft, settings, you]);

  const save = async (): Promise<Issue | null> => {
    if (!issue) return null;
    if (!dirty) return issue;
    setBusy('save'); setErr('');
    try {
      const i = await api.update(issue.id, issue.version, draft);
      const r = await api.get(i.id);
      adopt(r.issue, r.checks); onChanged(r.issue); setSavedAt(Date.now());
      return r.issue;
    } catch (e) {
      setErr(e instanceof NewslettersError && e.code === 'issue_conflict' ? 'Someone saved this newsletter first. Copy your changes, then reload.' : errorText(e));
      return null;
    } finally { setBusy(''); }
  };

  const act = async (name: 'review' | 'schedule' | 'cancel' | 'resume' | 'duplicate', extra: Record<string, unknown> = {}) => {
    const cur = await save();
    if (!cur) return;
    setBusy(name); setErr('');
    try {
      const i = await api.action(cur.id, name, { version: cur.version, contentHash: cur.contentHash, ...extra });
      if (name === 'duplicate') { toast('Copy created: ' + i.title); onChanged(i); onOpen(i.id); return; }
      const r = await api.get(i.id);
      adopt(r.issue, r.checks); onChanged(r.issue);
      if (name === 'schedule') { toast(extra.at ? 'Scheduled. It sends in batches from then.' : 'Sending. It goes out in batches.'); if (!extra.at) onOpen(i.id); }
      else toast({ review: 'Sent for approval. An admin approves it in Tasks & Approvals.', cancel: 'Stopped.', resume: 'Resumed.' }[name]);
    } catch (e) {
      const problems = e instanceof NewslettersError && Array.isArray(e.body.problems) ? (e.body.problems as string[]) : null;
      if (problems) setChecks(problems);
      setErr(errorText(e));
    } finally { setBusy(''); }
  };

  const runAssist = async (text: string) => {
    if (!issue || !assist) return;
    setBusy('assist');
    try {
      const r = await api.assist({ mode: text.length > 400 ? 'shorten' : 'draft', text, subject: draft.subject, template: issue.template });
      setAssist(a => a && { ...a, result: r.text, note: r.note });
    } catch (e) { setAssist(a => a && { ...a, result: '', note: errorText(e) }); } finally { setBusy(''); }
  };

  if (!issue) return <div className="card panel">{err ? <span className="tone-danger">{err} <button className="link-btn" onClick={reload}>Try again</button></span> : <span className="an-loading"><span className="spinner" /> Loading…</span>}</div>;

  const def = templateDef(issue.template);
  const testing = isTestingTemplate(issue.template);
  const pill = statusPill(issue);
  const approvedStep = issue.status === 'approved' || issue.status === 'scheduled';
  const left = placeholders(draft.blocks.filter(b => !b.hidden), draft.subject || '', draft.preheader || '');
  const linkAud = link?.audiences || [];
  const people = lists.filter(l => draft.listIds.includes(l.id)).reduce((a, l) => a + l.subscribed, 0) + linkAud.filter(a => draft.audiences.includes(a.key)).reduce((a, x) => a + x.count, 0);
  const shownSections = draft.blocks.filter(b => !b.hidden).length;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const steps: [number, string, string][] = [
    [1, 'Template', TEMPLATE_NAME[issue.template] + (issue.variant === 'online' ? ' · Online' : '')],
    [2, 'Content', shownSections + ' of ' + draft.blocks.length + ' sections'],
    [3, 'Audience', [...lists.filter(l => draft.listIds.includes(l.id)).map(l => l.name), ...linkAud.filter(a => draft.audiences.includes(a.key)).map(a => a.name), ...draft.audiences.filter(k => !linkAud.some(a => a.key === k)).map(k => k.startsWith('testers:') ? 'Picked testers' : k)].join(', ') || 'Not chosen']
  ];

  return (
    <div className="nl-editor">
      <div className="nl-head">
        <div className="nl-head-main">
          <span className="mono-label"><button className="link-btn plain" onClick={async () => { if (!dirty || window.confirm('Leave without saving your changes?')) onClose(); }}>{testing ? 'Product testing' : 'Newsletters'}</button> / {issue.status === 'draft' && issue.version <= 1 ? 'New ' + (testing ? 'email' : 'newsletter') : TEMPLATE_NAME[issue.template]}</span>
          <div className="row-wrap" style={{ alignItems: 'center', gap: 10 }}>
            <input className="input nl-title" aria-label="Title" value={draft.title || ''} disabled={!editable} maxLength={120} onChange={e => change({ title: e.target.value })} />
            <span className={'pill ' + (approvedStep ? 'ok' : pill.tone)}>Version {issue.version} · {pill.label}</span>
          </div>
          <span className="faint">{dirty ? 'Unsaved changes' : savedAt ? 'Saved · ' + when(savedAt) : 'Saved · ' + when(issue.updatedAt)}</span>
        </div>
      </div>

      <div className="nl-stepper" role="tablist" aria-label="Steps">
        {steps.map(([n, l, sub]) => {
          const done = n < step || approvedStep;
          return (
            <button key={n} role="tab" aria-selected={step === n} className={'nl-step' + (step === n ? ' on' : '') + (done ? ' done' : '')} onClick={() => setStep(n)}>
              <span className="nl-step-dot">{done && step !== n ? '✓' : n}</span>
              <span className="nl-step-text"><b>{l}</b><span>{sub}</span></span>
            </button>
          );
        })}
      </div>

      {err && <div className="notice danger" role="alert">{err} <button className="link-btn" onClick={reload}>Reload</button></div>}
      {issue.lastError && <div className="notice warn">{issue.lastError}</div>}

      <div className="nl-cols">
        <div className="nl-form">
          {step === 1 && (
            <div className="card panel">
              <span className="mono-label">Template</span>
              <b>{def.name}{issue.variant === 'online' ? ' · Online' : ''}</b>
              <span className="muted">{def.description}</span>
              {def.locked && <span className="pill warn" style={{ alignSelf: 'flex-start' }}>Approval always required</span>}
              <span className="faint">To use another template, start a new {testing ? 'email' : 'newsletter'}; this one keeps its content.</span>
            </div>
          )}

          {step === 2 && (
            <>
              <div className="card panel">
                <span className="mono-label">Inbox</span>
                <label className="nl-field"><span className="nl-field-head"><b>Subject</b><em className={(draft.subject || '').length > 60 ? 'tone-danger' : 'faint'}>{(draft.subject || '').length} / 60</em></span>
                  <input className="input" value={draft.subject || ''} maxLength={200} disabled={!editable} onChange={e => change({ subject: e.target.value })} />
                </label>
                {canAssist && editable && <span><button className="link-btn" disabled={!!busy} onClick={() => api.assist({ mode: 'subjects', text: draft.blocks.map(b => ('text' in b ? b.text : '')).join('\n\n').slice(0, 8000), subject: draft.subject, template: issue.template }).then(r => setSubjects(r.subjects)).catch(e => toast(errorText(e), true))}>Suggest subject lines</button></span>}
                {subjects.length > 0 && <div className="row-wrap">{subjects.map(s => <button key={s} className="btn soft sm" onClick={() => { change({ subject: s }); setSubjects([]); }}>{s}</button>)}</div>}
                <label className="nl-field"><span className="nl-field-head"><b>Preheader</b><em className={(draft.preheader || '').length > 90 ? 'tone-danger' : 'faint'}>{(draft.preheader || '').length} / 90</em></span>
                  <input className="input" value={draft.preheader || ''} maxLength={200} disabled={!editable} onChange={e => change({ preheader: e.target.value })} />
                </label>
                <div className="row-wrap">
                  <label className="nl-field" style={{ flex: '1 1 150px' }}><span className="nl-field-head"><b>Edition</b></span>
                    <input className="input" value={draft.edition || ''} maxLength={60} placeholder="No. 15 · November 2026" disabled={!editable} onChange={e => change({ edition: e.target.value })} />
                  </label>
                  <label className="nl-field" style={{ flex: '1 1 220px' }}><span className="nl-field-head"><b>From</b></span>
                    <select className="input" value={draft.fromEmail || ''} disabled={!editable} onChange={e => change({ fromEmail: e.target.value })}>
                      <option value="">{senders[0]?.email || you.email} (your sending address)</option>
                      {senders.filter((x, i) => i > 0 || x.email !== (senders[0]?.email)).map(x => <option key={x.email} value={x.email}>{x.email}</option>)}
                    </select>
                  </label>
                </div>
                {(issue.template === 'letter' || issue.template === 'founder') && (
                  <div className="row-wrap">
                    <label className="nl-field" style={{ flex: '1 1 160px' }}><span className="nl-field-head"><b>Sender title</b></span>
                      <input className="input" value={draft.signoff?.title || ''} maxLength={100} disabled={!editable} onChange={e => change({ signoff: { title: e.target.value, calendarUrl: draft.signoff?.calendarUrl || '' } })} />
                    </label>
                    <label className="nl-field" style={{ flex: '1 1 200px' }}><span className="nl-field-head"><b>Calendar link</b></span>
                      <input className="input" value={draft.signoff?.calendarUrl || ''} placeholder="https://" maxLength={600} disabled={!editable} onChange={e => change({ signoff: { title: draft.signoff?.title || '', calendarUrl: e.target.value } })} />
                    </label>
                  </div>
                )}
              </div>

              {draft.blocks.map((b, i) => (
                <div key={b.id} className={'card panel nl-section' + (b.hidden ? ' removed' : '')}>
                  <div className="nl-section-head">
                    <b>{sectionName(b)}</b>
                    <span className="faint">{BLOCK_LABEL[b.type]}</span>
                    <span style={{ flex: 1 }} />
                    {editable && (
                      <>
                        <button className="btn ghost sm" aria-label="Move up" disabled={!i} onClick={() => move(i, -1)}>↑</button>
                        <button className="btn ghost sm" aria-label="Move down" disabled={i === draft.blocks.length - 1} onClick={() => move(i, 1)}>↓</button>
                        <label className="nl-switch">
                          <input type="checkbox" checked={!!b.hidden} onChange={e => setBlock(i, { ...b, hidden: e.target.checked || undefined })} />
                          <span className="nl-switch-track" aria-hidden="true" /> Remove section
                        </label>
                        <button className="btn ghost sm danger" aria-label="Delete section" title="Delete section" onClick={() => change({ blocks: draft.blocks.filter((_, j) => j !== i) })}>✕</button>
                      </>
                    )}
                  </div>
                  {b.hidden
                    ? <span className="faint">Removed from this issue. The section and its label won’t be sent.</span>
                    : <BlockForm block={b} disabled={!editable} onChange={x => setBlock(i, x)} onAssist={canAssist ? (text, apply) => setAssist({ text, apply, result: '', note: '' }) : undefined} />}
                </div>
              ))}
              {editable && (
                <select className="input" aria-label="Add a section" value="" onChange={e => {
                  if (!e.target.value) return;
                  change({ blocks: [...draft.blocks, emptyBlock(e.target.value as BlockType)] });
                }}>
                  <option value="">+ Add a section…</option>
                  {ADDABLE.map(t => <option key={t} value={t}>{BLOCK_LABEL[t]}</option>)}
                </select>
              )}
              <span className="faint" style={{ fontSize: 12 }}>Merge tokens: {'{first_name}'}, {'{last_name}'}, {'{company|your team}'}. The footer and disclaimer come from Newsletter settings.</span>
            </>
          )}

          {step === 3 && (
            <>
              {!testing && lists.length > 0 && (
                <div className="card panel">
                  <span className="mono-label">Lists in Mail</span>
                  {lists.map(l => (
                    <label key={l.id} className="nl-aud">
                      <input type="checkbox" disabled={!editable} checked={draft.listIds.includes(l.id)}
                        onChange={e => change({ listIds: e.target.checked ? [...draft.listIds, l.id] : draft.listIds.filter(x => x !== l.id) })} />
                      <span className="nl-aud-main">
                        <b>{l.name}</b>{l.requiresApproval && <span className="pill warn">Approval always required</span>}
                        <span className="faint">{l.description || 'Signed up on axal.vc or added by an admin'}</span>
                        <span className="muted">{l.subscribed} will receive</span>
                      </span>
                    </label>
                  ))}
                </div>
              )}
              <div className="card panel">
                <div className="row-wrap" style={{ alignItems: 'center' }}>
                  <span className="mono-label">Lists from StudioOS</span>
                  <span style={{ flex: 1 }} />
                  {link?.configured && !link.error && <span className="faint">Counts read {Math.max(0, Math.round((Date.now() - link.at) / 60000))} min ago</span>}
                  <button className="btn ghost sm" aria-label="Read again" onClick={loadLink}>↻</button>
                </div>
                {!link && <div className="nl-skel" aria-label="Loading"><span /><span /><span /></div>}
                {link && !link.configured && <span className="muted">Not connected: an admin sets the link secret. Until then, StudioOS lists can’t be read and nothing can be sent to them.</span>}
                {link?.error && <span className="tone-danger">StudioOS didn’t answer, so counts are hidden. Sending waits until lists can be read. <button className="link-btn" onClick={loadLink}>Try again</button></span>}
                {link?.configured && !link.error && !linkAud.length && <span className="faint">No lists yet. Lists appear once StudioOS has subscribers or members.</span>}
                {linkAud.filter(a => !testing || a.key.startsWith('testers:')).map(a => (
                  <label key={a.key} className="nl-aud">
                    <input type="checkbox" disabled={!editable} checked={draft.audiences.includes(a.key)}
                      onChange={e => change({ audiences: e.target.checked ? [...draft.audiences, a.key] : draft.audiences.filter(x => x !== a.key) })} />
                    <span className="nl-aud-main">
                      <b>{a.name}</b>{a.requiresApproval && <span className="pill warn">Approval always required</span>}
                      <span className="faint">{a.source || a.group}</span>
                      <span className="muted">{a.count} will receive · {a.unsubscribed} unsubscribed · {a.bounced} bounced</span>
                    </span>
                  </label>
                ))}
                {draft.audiences.filter(k => !linkAud.some(a => a.key === k)).map(k => (
                  <span key={k} className="muted">✓ {k.startsWith('testers:') ? 'Picked testers of this programme' : k} <span className="faint">(read from StudioOS when sending starts)</span></span>
                ))}
                <span className="faint">Lists are kept in StudioOS. Unsubscribed and bounced people are never sent to.</span>
              </div>
              <div className="notice accent">{people ? people + ' people will receive this' : 'Counts appear when the lists can be read'}{issue.audience !== undefined && !dirty && issue.excluded && issue.excluded.unsubscribed + issue.excluded.bounced > 0 ? ` · ${issue.excluded.unsubscribed} unsubscribed and ${issue.excluded.bounced} bounced are left out` : ''}</div>
            </>
          )}

          {step === 4 && (
            <div className="card panel">
              {issue.approved
                ? <div className="notice ok-note"><b>Version {issue.version} approved by {issue.approvedBy} · {when(issue.approvedAt)}</b><br />This exact version will be sent. Editing creates version {issue.version + 1}, which needs approval again.</div>
                : <div className="notice warn">This version isn’t approved. Request approval first: nothing is sent without an approved version.</div>}
              {issue.status === 'scheduled' && <span className="muted">Scheduled for {when(issue.scheduledAt)}.</span>}
              {issue.canSchedule && (
                <>
                  <span className="mono-label">Schedule</span>
                  <div className="row-wrap" style={{ alignItems: 'center' }}>
                    <input className="input" type="date" aria-label="Date" value={sched.date} onChange={e => setSched({ ...sched, date: e.target.value })} />
                    <input className="input" type="time" aria-label="Time" value={sched.time} onChange={e => setSched({ ...sched, time: e.target.value })} />
                    <span className="pill">{tz}</span>
                    <button className="btn sm" disabled={!!busy || !sched.date || checks.length > 0} onClick={() => {
                      const t = new Date(sched.date + 'T' + (sched.time || '09:00')).getTime();
                      if (window.confirm('Schedule for ' + new Date(t).toLocaleString() + '?')) act('schedule', { at: t });
                    }}>Schedule</button>
                    <button className="btn primary sm" disabled={!!busy || checks.length > 0} onClick={() => { if (window.confirm('Send now to ' + (people || 'the') + ' people?')) act('schedule', { at: null }); }}>Send now</button>
                  </div>
                </>
              )}
              {issue.status === 'scheduled' && canManage && <button className="btn sm danger" style={{ alignSelf: 'flex-start' }} disabled={!!busy} onClick={() => act('cancel')}>Cancel schedule</button>}
              {!canManage && <span className="faint">An admin schedules or sends it.</span>}
            </div>
          )}

          <div className="card panel">
            <span className="mono-label">Before sending</span>
            {dirty ? <span className="muted">Save to run the checks.</span> : checks.length ? checks.map(c => <span key={c} className="tone-danger">✕ {c}</span>) : <span className="tone-ok">✓ Ready to send</span>}
            {left.length > 0 && <span className="muted">Placeholders left: {left.join(', ')}</span>}
          </div>
        </div>

        <Preview html={rendered.html} text={rendered.text} />
      </div>

      {assist && (
        <div className="modal-scrim" role="dialog" aria-label="Draft with the assistant" onClick={e => { if (e.target === e.currentTarget) setAssist(null); }}>
          <div className="modal" style={{ width: 560 }}>
            <div className="modal-head"><span className="mono-label" style={{ color: 'var(--accent-strong)' }}>AI</span><h3>Draft with the assistant</h3><span className="muted">Inserted only when you click Insert.</span></div>
            <div style={{ padding: '0 22px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
              <textarea className="textarea" rows={4} value={assist.text} placeholder="From these points: …" onChange={e => setAssist({ ...assist, text: e.target.value })} />
              {assist.result && <div className="nl-suggestion">{assist.result}</div>}
              {assist.note && <span className="faint">{assist.note}</span>}
              <span className="faint">Never writes figures, returns, valuations or fund terms.</span>
            </div>
            <div className="modal-foot">
              <button className="btn ghost sm" onClick={() => setAssist(null)}>Cancel</button>
              <button className="btn sm" disabled={busy === 'assist' || !assist.text.trim()} onClick={() => runAssist(assist.text)}>{busy === 'assist' ? 'Drafting…' : assist.result ? 'Try again' : 'Draft'}</button>
              <button className="btn primary sm" disabled={!assist.result} onClick={() => { assist.apply(assist.result); setAssist(null); }}>Insert</button>
            </div>
          </div>
        </div>
      )}

      <div className="nl-footbar">
        {canManage && (
          <span className="row-wrap" style={{ alignItems: 'center' }}>
            <button className="btn sm" disabled={!!busy} onClick={async () => {
              const cur = await save(); if (!cur) return;
              setBusy('test');
              api.test(cur.id).then(r => toast('Test sent to ' + r.to)).catch(e => setErr(errorText(e))).finally(() => setBusy(''));
            }}>{busy === 'test' ? 'Sending…' : 'Send a test to me'}</button>
            <span className="faint">Only to {you.email}</span>
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button className="btn ghost sm" disabled={!!busy} onClick={() => act('duplicate')}>Duplicate</button>
        {['draft', 'in_review', 'cancelled'].includes(issue.status) && (issue.createdBy === you.email || canManage) && (
          <button className="btn ghost sm danger" disabled={!!busy} onClick={() => { if (window.confirm('Delete this draft?')) api.remove(issue.id).then(() => { onChanged(null); onClose(); }).catch(e => setErr(errorText(e))); }}>Delete</button>
        )}
        {editable && <button className="btn sm" disabled={!dirty || !!busy} onClick={save}>{busy === 'save' ? 'Saving…' : 'Save draft'}</button>}
        {step < 3 && !approvedStep && <button className="btn sm" onClick={() => setStep(step + 1)}>Next: {steps[step][1]}</button>}
        {issue.status === 'draft' && <button className="btn primary sm" disabled={!!busy} onClick={() => act('review')}>Request approval</button>}
        {issue.status === 'in_review' && <span className="pill warn">Awaiting approval{issue.reviewRequestedBy ? ' · asked by ' + issue.reviewRequestedBy.split('@')[0] : ''}</span>}
        {approvedStep && step !== 4 && <button className="btn primary sm" onClick={() => setStep(4)}>Schedule or send</button>}
      </div>
    </div>
  );
}
