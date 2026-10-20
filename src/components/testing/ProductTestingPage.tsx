import { useCallback, useEffect, useState } from 'react';
import type { TemplateId } from '../../lib/newsletter/types';
import type { Applicant, Issue, NewslettersApi, NlList, NlSettings, Programme, Tester } from '../../lib/newslettersApi';
import { statusPill } from '../../lib/newslettersApi';
import { errorText } from '../Toast';
import { Composer } from '../newsletters/Composer';
import { SentView } from '../newsletters/SentView';

const STATUS: Record<string, [string, string]> = {
  draft: ['Draft', ''], submitted: ['Waiting for HQ', 'warn'], approved: ['Approved by HQ', 'accent'], rejected: ['Sent back', 'warn'],
  open: ['Open', 'ok'], testing: ['Testing', 'accent'], closed: ['Closed', '']
};
const APP_STATUS: Record<string, [string, string]> = { applied: ['Applied', ''], picked: ['Picked', 'ok'], declined: ['Not this time', ''], withdrawn: ['Withdrawn', ''] };
const EMAILS: [TemplateId, string, string][] = [
  ['pt_in', 'You’re in', 'Instructions and the link'],
  ['pt_not', 'Not this time', 'For applicants who weren’t picked'],
  ['pt_reminder', 'Reminder', 'Halfway through testing'],
  ['pt_survey', 'Survey', 'Feedback form when testing ends'],
  ['pt_thanks', 'Thank you', 'After the programme closes']
];
const day = (t: number | null) => (t ? new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—');
const dates = (p: Programme) => (p.status === 'closed' ? 'Closed ' + day(p.closesAt) : day(p.testingStartsAt || p.opensAt) + ' – ' + day(p.testingEndsAt || p.closesAt));

interface Props {
  api: NewslettersApi | null;
  you: { email: string; name: string };
  canAssist: boolean;
  toast: (t: { text: string; error?: boolean }) => void;
}

type View = { k: 'list' } | { k: 'programme'; uid: string } | { k: 'email'; uid: string; id: number };

export function ProductTestingPage({ api, you, canAssist, toast }: Props) {
  const [view, setView] = useState<View>({ k: 'list' });
  const [list, setList] = useState<{ configured: boolean; studioUrl: string; programmes: Programme[]; error?: string } | null>(null);
  const [err, setErr] = useState('');
  const [meta, setMeta] = useState<{ lists: NlList[]; canManage: boolean; settings: NlSettings | null }>({ lists: [], canManage: false, settings: null });
  const say = (text: string, error = false) => toast({ text, error });

  const load = useCallback(() => {
    if (!api) return;
    setErr(''); setList(null);
    api.programmes().then(setList).catch(e => setErr(errorText(e)));
    api.overview().then(r => setMeta(m => ({ ...m, lists: r.lists, canManage: r.canManage }))).catch(() => {});
    api.settings().then(s => setMeta(m => ({ ...m, settings: s }))).catch(() => {});
  }, [api]);
  useEffect(load, [load]);

  const page = (body: React.ReactNode, wide = false) => (
    <section className="admin" aria-label="Product testing"><div className="page-inner" style={{ gap: 14, maxWidth: wide ? 1400 : undefined }}>{body}</div></section>
  );
  if (!api) return page(<div className="card panel"><span className="muted">Product testing needs the Axal VC Mail backend (sign in with Google).</span></div>);

  if (view.k === 'email') {
    return page(<EmailView api={api} id={view.id} lists={meta.lists} settings={meta.settings} you={you} canManage={meta.canManage} canAssist={canAssist} toast={say}
      onBack={() => setView({ k: 'programme', uid: view.uid })} onOpen={id => setView({ k: 'email', uid: view.uid, id })} />, true);
  }
  if (view.k === 'programme') {
    const p = list?.programmes.find(x => x.uid === view.uid) || null;
    return page(<ProgrammeView api={api} uid={view.uid} summary={p} studioUrl={list?.studioUrl || ''} toast={say}
      onBack={() => setView({ k: 'list' })} onOpenEmail={id => setView({ k: 'email', uid: view.uid, id })} />, true);
  }

  return page(<>
    <div className="nl-head">
      <div className="nl-head-main">
        <span className="mono-label">Workspace</span>
        <h1>Product testing</h1>
        <span className="muted">Programmes run by Axal VC and partners, read from StudioOS. Emails to applicants and testers go out from here, through approval.</span>
      </div>
      <div className="row-wrap">
        <button className="btn ghost sm" aria-label="Refresh" onClick={load}>↻</button>
        {list?.studioUrl && <a className="btn sm" href={list.studioUrl} target="_blank" rel="noreferrer">Open in StudioOS ↗</a>}
      </div>
    </div>
    {err && <div className="card panel nl-state"><b>Unreadable</b><span className="muted">{err}</span><button className="btn sm" onClick={load}>Try again</button></div>}
    {!list && !err && <div className="nl-prgs">{[0, 1, 2].map(i => <div key={i} className="card panel nl-skel"><span /><span /><span /></div>)}</div>}
    {list && !list.configured && (
      <div className="card panel nl-state">
        <span className="pill">Not connected</span>
        <b>Not connected: an admin sets the link secret</b>
        <span className="muted">Until then, programmes can’t be read from StudioOS and nothing can be sent to testers. The owner sets MAIL_LINK_SECRET, the same value in both Workers.</span>
      </div>
    )}
    {list?.configured && list.error && <div className="card panel nl-state"><b>Unreadable</b><span className="muted">Programmes couldn’t be read from StudioOS. ({list.error})</span><button className="btn sm" onClick={load}>Try again</button></div>}
    {list?.configured && !list.error && !list.programmes.length && (
      <div className="card panel nl-state"><b>No programmes yet.</b><span className="muted">Axal VC and partners create programmes in StudioOS.</span></div>
    )}
    {list?.configured && !list.error && list.programmes.length > 0 && (
      <>
        <div className="nl-prgs">
          {list.programmes.map(p => {
            const [label, tone] = STATUS[p.status] || [p.status, ''];
            const pct = p.places ? Math.round((p.picked / p.places) * 100) : 0;
            return (
              <button key={p.uid} className="card panel nl-prg" onClick={() => setView({ k: 'programme', uid: p.uid })}>
                <span className="row-wrap" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
                  <span className="nl-prg-logo">{p.logoUrl ? <img src={p.logoUrl} alt="" /> : p.name.slice(0, 1)}</span>
                  <span className={'pill ' + tone}>{label}</span>
                </span>
                <b>{p.name}</b>
                <span className="faint">Run by {p.ownerName} {p.ownerKind === 'partner' && <span className="pill">Partner</span>}</span>
                <span className="nl-prg-row"><span className="mono-label">Places</span><span>{p.picked} of {p.places} taken</span></span>
                <div className="nl-progress"><span style={{ width: pct + '%' }} /></div>
                <span className="nl-prg-row"><span className="faint">{p.status === 'submitted' ? 'Opens after HQ approval' : p.status === 'draft' ? 'Not open yet' : p.applicants + ' applicants'}</span><span className="faint">{dates(p)}</span></span>
              </button>
            );
          })}
        </div>
        <span className="faint">Programmes are created, approved and staffed in StudioOS. Mail reads them and sends their emails.</span>
      </>
    )}
  </>);
}

function ProgrammeView({ api, uid, summary, studioUrl, toast, onBack, onOpenEmail }: {
  api: NewslettersApi; uid: string; summary: Programme | null; studioUrl: string; toast: (t: string, e?: boolean) => void; onBack: () => void; onOpenEmail: (id: number) => void;
}) {
  const [tab, setTab] = useState<'applicants' | 'testers' | 'emails'>('applicants');
  const [data, setData] = useState<{ programme: Programme | null; applicants: Applicant[]; testers: Tester[]; error?: string } | null>(null);
  const [emails, setEmails] = useState<Issue[] | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    setData(null);
    api.programme(uid).then(setData).catch(e => setData({ programme: null, applicants: [], testers: [], error: errorText(e) }));
    api.overview({ programme: uid }).then(r => setEmails(r.issues)).catch(() => setEmails([]));
  }, [api, uid]);
  useEffect(load, [load]);
  const p = data?.programme || summary;
  const [label, tone] = p ? STATUS[p.status] || [p.status, ''] : ['', ''];
  const start = async (t: TemplateId) => {
    setBusy(true);
    try { const i = await api.create(t, { programmeUid: uid, programmeName: p?.name || '' }); onOpenEmail(i.id); } catch (e) { toast(errorText(e), true); } finally { setBusy(false); }
  };

  return (
    <>
      <div className="nl-head">
        <div className="nl-head-main">
          <span className="mono-label"><button className="link-btn plain" onClick={onBack}>Product testing</button> / Programme</span>
          <div className="row-wrap" style={{ alignItems: 'center', gap: 10 }}><h1>{p?.name || 'Programme'}</h1>{p && <span className={'pill ' + tone}>{label}</span>}</div>
          {p && <span className="muted">Run by {p.ownerName}{p.ownerKind === 'partner' ? ' · Partner' : ''} · {p.picked} of {p.places} places taken · {dates(p)}</span>}
        </div>
        <div className="row-wrap">
          {studioUrl && <a className="btn sm" href={studioUrl} target="_blank" rel="noreferrer">Open in StudioOS ↗</a>}
          <button className="btn primary sm" disabled={busy} onClick={() => start('pt_in')}>New email to testers</button>
        </div>
      </div>
      {p?.summary && <div className="card panel"><span className="muted">{p.summary}</span>{p.tasks && <span className="faint">Testers: {p.tasks}{p.timeNeeded ? ' · ' + p.timeNeeded : ''}</span>}</div>}
      <div className="seg" role="tablist" aria-label="Programme">
        {([['applicants', 'Applicants', data?.applicants.length], ['testers', 'Testers', data?.testers.length], ['emails', 'Emails', 5]] as [typeof tab, string, number | undefined][]).map(([k, l, c]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l} <span className="faint">{c ?? ''}</span></button>
        ))}
      </div>
      {data?.error && <div className="card panel nl-state"><b>Unreadable</b><span className="muted">{data.error}</span><button className="btn sm" onClick={load}>Try again</button></div>}
      {!data && <div className="card panel nl-skel"><span /><span /><span /></div>}

      {data && !data.error && tab === 'applicants' && (data.applicants.length ? (
        <>
          <div className="card table table-scroll">
            <div className="trow nl-appl head"><span>APPLICANT</span><span>ROLE</span><span>WHY THEY APPLIED</span><span>APPLIED ON</span><span>STATUS</span></div>
            {data.applicants.map(a => {
              const [l, t] = APP_STATUS[a.status] || [a.status, ''];
              return (<div key={a.uid} className="trow nl-appl"><b>{a.name}</b><span className="muted">{a.role}</span><span className="faint">{a.why || '—'}</span><span className="muted">{day(a.appliedAt)}</span><span><span className={'pill ' + t}>{l}</span></span></div>);
            })}
          </div>
          <span className="faint">Picking testers is done by the programme’s owner in StudioOS. Mail shows who was picked.</span>
        </>
      ) : <div className="card panel nl-state"><span className="faint">No applicants yet.</span></div>)}

      {data && !data.error && tab === 'testers' && (data.testers.length ? (
        <div className="card table table-scroll">
          <div className="trow nl-testers head"><span>TESTER</span><span>EMAIL</span><span>PICKED ON</span><span>LAST EMAIL</span></div>
          {data.testers.map(t => {
            const last = (emails || []).filter(e => e.status === 'sent').sort((a, b) => (b.sentAt || 0) - (a.sentAt || 0))[0];
            return (<div key={t.uid} className="trow nl-testers"><span><b>{t.name}</b> <span className="faint">· {t.role}</span></span><span className="muted">{t.email || 'Only shared with consent'}</span><span className="muted">{day(t.pickedAt)}</span><span className="faint">{last ? last.title + ' · sent ' + day(last.sentAt) : '—'}</span></div>);
          })}
        </div>
      ) : <div className="card panel nl-state"><span className="faint">Nobody has been picked yet.</span></div>)}

      {data && tab === 'emails' && (
        <>
          <div className="card table table-scroll">
            <div className="trow nl-pem head"><span>EMAIL</span><span>SENT TO</span><span>STATUS</span><span /></div>
            {EMAILS.map(([t, name, desc]) => {
              const mine = (emails || []).filter(e => e.template === t).sort((a, b) => b.updatedAt - a.updatedAt)[0];
              const pill = mine ? statusPill(mine) : { label: 'Not started', tone: '' };
              const to = t === 'pt_not' ? 'Not picked' : 'Picked testers · ' + (p?.picked ?? data.testers.length);
              return (
                <div key={t} className="trow nl-pem">
                  <span className="user-cell"><b>{name}</b><span>{desc}</span></span>
                  <span className="muted">{to}</span>
                  <span><span className={'pill ' + pill.tone}>{pill.label}</span></span>
                  <span style={{ textAlign: 'right' }}>
                    {mine ? <button className="btn sm" onClick={() => onOpenEmail(mine.id)}>{mine.status === 'sent' ? 'View' : mine.status === 'in_review' ? 'Open' : 'Edit'}</button>
                      : <button className="btn sm" disabled={busy} onClick={() => start(t)}>Write</button>}
                  </span>
                </div>
              );
            })}
          </div>
          <span className="faint">Each email starts from a template and needs approval before it’s sent. Editing after approval needs approval again. StudioOS shares addresses only for picked testers who agreed to emails; it tells applicants who weren’t picked in the app.</span>
        </>
      )}
    </>
  );
}

function EmailView({ api, id, lists, settings, you, canManage, canAssist, toast, onBack, onOpen }: {
  api: NewslettersApi; id: number; lists: NlList[]; settings: NlSettings | null; you: { email: string; name: string }; canManage: boolean; canAssist: boolean;
  toast: (t: string, e?: boolean) => void; onBack: () => void; onOpen: (id: number) => void;
}) {
  const [issue, setIssue] = useState<Issue | null>(null);
  useEffect(() => { api.get(id).then(r => setIssue(r.issue)).catch(e => toast(errorText(e), true)); }, [api, id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!issue) return <div className="card panel nl-skel"><span /><span /></div>;
  if (['sending', 'sent', 'paused'].includes(issue.status)) {
    return <SentView api={api} issue={issue} lists={lists} canManage={canManage} toast={toast} onBack={onBack} onChanged={setIssue}
      onDuplicate={() => api.action(issue.id, 'duplicate').then(n => onOpen(n.id)).catch(e => toast(errorText(e), true))} />;
  }
  return <Composer key={id} api={api} id={id} lists={lists} settings={settings} you={you} canManage={canManage} canAssist={canAssist} toast={toast}
    onClose={onBack} onOpen={onOpen} onChanged={i => { if (i) setIssue(i); else onBack(); }} />;
}
