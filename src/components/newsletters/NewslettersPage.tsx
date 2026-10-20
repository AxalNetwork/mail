import { useCallback, useEffect, useMemo, useState } from 'react';
import type { TemplateId } from '../../lib/newsletter/types';
import { NEWSLETTER_TEMPLATES } from '../../lib/newsletter/templates';
import { renderIssue, SAMPLE_RECIPIENT, TEMPLATE_NAME } from '../../lib/newsletter/render';
import type { Issue, IssueStatus, NewslettersApi, NlList, NlSettings } from '../../lib/newslettersApi';
import { NewslettersError, statusPill } from '../../lib/newslettersApi';
import { errorText } from '../Toast';
import { Composer } from './Composer';
import { SentView } from './SentView';
import { SubscribersTab } from './SubscribersTab';
import { SettingsTab } from './SettingsTab';
import { AudiencesTab } from './AudiencesTab';

type Tab = 'drafts' | 'review' | 'scheduled' | 'sent';
type View = { k: 'list' } | { k: 'new' } | { k: 'issue'; id: number } | { k: 'settings' } | { k: 'lists' };

const IN: Record<Tab, IssueStatus[]> = { drafts: ['draft', 'cancelled'], review: ['in_review'], scheduled: ['approved', 'scheduled', 'sending', 'paused'], sent: ['sent'] };
const TABS: [Tab, string][] = [['drafts', 'Drafts'], ['review', 'Awaiting approval'], ['scheduled', 'Scheduled'], ['sent', 'Sent']];
const USED: Partial<Record<TemplateId, string>> = {
  brief: 'Monthly · website subscribers', letter: 'Quarterly · investors and LPs', spotlight: 'One company · portfolio news', founder: 'Invitation to apply · founders',
  event_invite: 'Before an event · guests', event_recap: 'After an event · attendees', insights: 'One essay in full · insights', announcement: 'Firm news · any list'
};

interface Props {
  api: NewslettersApi | null;
  you: { email: string; name: string };
  canAssist: boolean;
  toast: (t: { text: string; error?: boolean }) => void;
  /** Open this issue first (e.g. from Product testing). */
  initialIssue?: number | null;
}

const when = (t: number | null) => (t ? new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');

export function NewslettersPage({ api, you, canAssist, toast, initialIssue }: Props) {
  const [view, setView] = useState<View>(initialIssue ? { k: 'issue', id: initialIssue } : { k: 'list' });
  const [tab, setTab] = useState<Tab>('drafts');
  const [q, setQ] = useState('');
  const [data, setData] = useState<{ issues: Issue[]; lists: NlList[]; canManage: boolean; role: string } | null>(null);
  const [settings, setSettings] = useState<NlSettings | null>(null);
  const [err, setErr] = useState('');
  const [online, setOnline] = useState(false);
  const [picked, setPicked] = useState<TemplateId>('brief');
  const [busy, setBusy] = useState(false);
  const [listsTab, setListsTab] = useState<'audiences' | 'subscribers'>('audiences');

  const load = useCallback(() => {
    if (!api) return;
    setErr('');
    api.overview().then(setData).catch(e => setErr(e instanceof NewslettersError && e.code === 'schema_outdated'
      ? 'Newsletters need the database update. An administrator runs the pending migrations: npm run db:migrate.'
      : 'The newsletter list couldn’t be read. Nothing was changed. (' + errorText(e) + ')'));
    api.settings().then(setSettings).catch(() => {});
  }, [api]);
  useEffect(load, [load]);
  useEffect(() => { if (initialIssue) setView({ k: 'issue', id: initialIssue }); }, [initialIssue]);

  const say = (text: string, error = false) => toast({ text, error });
  const shown = useMemo(() => (data ? data.issues.filter(i => IN[tab].includes(i.status) && (!q || (i.title + ' ' + i.subject + ' ' + TEMPLATE_NAME[i.template]).toLowerCase().includes(q.toLowerCase()))) : []), [data, tab, q]);
  const thumbs = useMemo(() => Object.fromEntries(NEWSLETTER_TEMPLATES.map(t => [t.id, renderIssue({
    content: { template: t.id, subject: t.subject, preheader: t.preheader, blocks: (t.id === 'event_invite' && online && t.variants?.online ? t.variants.online : t.blocks)() },
    edition: '', brand: { fromName: 'Axal VC', postalAddress: settings?.postalAddress || '', disclaimer: '' }, recipient: SAMPLE_RECIPIENT,
    sender: { name: you.name, title: '', email: you.email, calendarUrl: '' }
  }).html])), [online, settings, you]);

  const page = (body: React.ReactNode, wide = false) => (
    <section className="admin" aria-label="Newsletters">
      <div className="page-inner" style={{ gap: 14, maxWidth: wide ? 1400 : undefined }}>{body}</div>
    </section>
  );
  if (!api) return page(<div className="card panel"><span className="muted">Newsletters need the Axal VC Mail backend (sign in with Google).</span></div>);

  const manage = !!data?.canManage;
  const upsert = (i: Issue | null, id?: number) => setData(d => d && (i
    ? { ...d, issues: d.issues.some(x => x.id === i.id) ? d.issues.map(x => (x.id === i.id ? i : x)) : [i, ...d.issues] }
    : { ...d, issues: d.issues.filter(x => x.id !== id) }));

  if (view.k === 'issue' && data) {
    const i = data.issues.find(x => x.id === view.id);
    if (i && ['sending', 'sent', 'paused'].includes(i.status)) {
      return page(<SentView api={api} issue={i} lists={data.lists} canManage={manage} toast={say} onBack={() => { setView({ k: 'list' }); load(); }} onChanged={x => upsert(x)}
        onDuplicate={() => api.action(i.id, 'duplicate').then(n => { upsert(n); setView({ k: 'issue', id: n.id }); say('Copy created. Edit it, then ask for approval.'); }).catch(e => say(errorText(e), true))} />, true);
    }
    return page(<Composer key={view.id} api={api} id={view.id} lists={data.lists} settings={settings} you={you} canManage={manage} canAssist={canAssist} toast={say}
      onClose={() => { setView({ k: 'list' }); load(); }} onOpen={id => { load(); setView({ k: 'issue', id }); }} onChanged={x => upsert(x, view.id)} />, true);
  }

  const head = (eyebrow: string, title: string, line: string, actions: React.ReactNode) => (
    <div className="nl-head">
      <div className="nl-head-main"><span className="mono-label">{eyebrow}</span><h1>{title}</h1><span className="muted">{line}</span></div>
      <div className="row-wrap">{actions}</div>
    </div>
  );

  if (view.k === 'settings') {
    return page(<>
      {head('Newsletters / Settings', 'Newsletter settings', 'Used by every newsletter and testing email.', <button className="btn sm" onClick={() => setView({ k: 'list' })}>← Newsletters</button>)}
      {!manage && <div className="notice warn">Only an admin changes newsletter settings.</div>}
      {settings && manage && <SettingsTab api={api} settings={settings} you={you.email} superAdmin={data?.role === 'super_admin'} onSaved={setSettings} toast={say} />}
    </>);
  }

  if (view.k === 'lists' && data) {
    return page(<>
      {head('Newsletters / Lists', 'Lists & subscribers', 'Mail’s own lists: website signups (until StudioOS keeps them), imports and people added by an admin.', <button className="btn sm" onClick={() => setView({ k: 'list' })}>← Newsletters</button>)}
      <div className="an-tabs" role="tablist">
        <button role="tab" aria-selected={listsTab === 'audiences'} className={'btn sm ' + (listsTab === 'audiences' ? 'primary' : 'ghost')} onClick={() => setListsTab('audiences')}>Lists</button>
        {manage && <button role="tab" aria-selected={listsTab === 'subscribers'} className={'btn sm ' + (listsTab === 'subscribers' ? 'primary' : 'ghost')} onClick={() => setListsTab('subscribers')}>Subscribers</button>}
      </div>
      {listsTab === 'audiences' && <AudiencesTab api={api} lists={data.lists} canManage={manage} superAdmin={data.role === 'super_admin'} onLists={lists => setData(d => d && { ...d, lists })} toast={say} />}
      {listsTab === 'subscribers' && manage && <SubscribersTab api={api} lists={data.lists} toast={say} />}
    </>);
  }

  if (view.k === 'new') {
    const create = async () => {
      setBusy(true);
      try {
        const i = await api.create(picked, { variant: picked === 'event_invite' && online ? 'online' : undefined });
        upsert(i);
        setView({ k: 'issue', id: i.id });
      } catch (e) { say(errorText(e), true); } finally { setBusy(false); }
    };
    return page(<>
      {head('Newsletters / New newsletter', 'Choose a template', 'Each card shows the real email.', <>
        <button className="btn sm" onClick={() => setView({ k: 'list' })}>Cancel</button>
        <button className="btn primary sm" disabled={busy} onClick={create}>{busy ? 'Starting…' : 'Use ' + TEMPLATE_NAME[picked]}</button>
      </>)}
      <div className="nl-tpls">
        {NEWSLETTER_TEMPLATES.map(t => (
          <div key={t.id} role="button" tabIndex={0} aria-pressed={picked === t.id} className={'nl-tpl card' + (picked === t.id ? ' on' : '')} onClick={() => setPicked(t.id)} onDoubleClick={create}
            onKeyDown={e => { if (e.key === 'Enter') setPicked(t.id); }}>
            <div className="nl-thumb"><iframe title={t.name} sandbox="" srcDoc={thumbs[t.id]} tabIndex={-1} /></div>
            <b>{t.name}</b>
            <span className="faint">{USED[t.id]}</span>
            {t.locked && <span className="pill warn" style={{ alignSelf: 'flex-start' }}>Approval always required</span>}
            {t.id === 'event_invite' && (
              <span className="seg" onClick={e => e.stopPropagation()}>
                <button className={!online ? 'on' : ''} onClick={() => setOnline(false)}>In person</button>
                <button className={online ? 'on' : ''} onClick={() => setOnline(true)}>Online</button>
              </span>
            )}
          </div>
        ))}
      </div>
      <span className="faint">Confirm subscription, Welcome, Unsubscribed and Preferences saved are sent the moment someone acts, so they aren’t offered here.</span>
    </>, true);
  }

  const count = (t: Tab) => (data ? data.issues.filter(i => IN[t].includes(i.status)).length : 0);
  return page(<>
    {head('Workspace', 'Newsletters', 'Compose newsletters, get each version approved, then send to your lists and to lists kept in StudioOS.', <>
      <button className="btn sm" onClick={() => setView({ k: 'lists' })}>Lists & subscribers</button>
      {manage && <button className="btn sm" onClick={() => setView({ k: 'settings' })}>Newsletter settings</button>}
      <button className="btn primary sm" onClick={() => setView({ k: 'new' })}>New newsletter</button>
    </>)}
    {manage && settings && !settings.postalAddress && <div className="notice accent">Add the firm’s postal address in Newsletter settings before the first send: every newsletter carries it. <button className="link-btn" onClick={() => setView({ k: 'settings' })}>Open settings</button></div>}
    <div className="row-wrap" style={{ alignItems: 'center' }}>
      <div className="seg" role="tablist" aria-label="Newsletters">
        {TABS.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l} <span className="faint">{count(k)}</span></button>)}
      </div>
      <span style={{ flex: 1 }} />
      <input className="input" type="search" placeholder="Search issues" aria-label="Search issues" value={q} onChange={e => setQ(e.target.value)} />
      <button className="btn ghost sm" aria-label="Refresh" onClick={load}>↻</button>
    </div>
    {err && <div className="card panel nl-state"><b>Unreadable</b><span className="muted">{err}</span><button className="btn sm" onClick={load}>Try again</button></div>}
    {!data && !err && <div className="card panel nl-skel" aria-label="Loading"><span /><span /><span /><span /></div>}
    {data && (shown.length ? (
      <div className="card table table-scroll" aria-label="Newsletters">
        <div className="trow nl-issues head"><span>ISSUE</span><span>AUDIENCE</span><span>AUTHOR</span><span>STATUS</span><span>LAST CHANGE</span></div>
        {shown.map(i => {
          const p = statusPill(i);
          const aud = [...i.listIds.map(id => data.lists.find(l => l.id === id)?.name), ...i.audiences].filter(Boolean);
          return (
            <button key={i.id} className="trow nl-issues link-like" onClick={() => setView({ k: 'issue', id: i.id })}>
              <span className="user-cell"><span>{TEMPLATE_NAME[i.template]}{i.variant === 'online' ? ' · Online' : ''}</span><b>{i.title}</b></span>
              <span className="user-cell"><b style={{ fontWeight: 400 }}>{aud.join(', ') || '—'}</b><span>{i.recipients ? i.recipients + ' people' : i.audience !== undefined ? i.audience + ' people' : ''}</span></span>
              <span className="muted">{i.createdBy.split('@')[0]}</span>
              <span><span className={'pill ' + p.tone}>{p.label}</span></span>
              <span className="muted">{when(i.updatedAt)}</span>
            </button>
          );
        })}
      </div>
    ) : (
      <div className="card panel nl-state">
        {data.issues.length ? <span className="faint">Nothing here{q ? ' matches “' + q + '”' : ''}.</span> : <>
          <b>No newsletters yet. Start from a template.</b>
          <span className="muted">Drafts, approvals and sent issues will appear here.</span>
          <button className="btn primary sm" onClick={() => setView({ k: 'new' })}>Choose a template</button>
        </>}
      </div>
    ))}
  </>);
}
