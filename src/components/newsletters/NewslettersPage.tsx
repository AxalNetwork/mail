import { useCallback, useEffect, useMemo, useState } from 'react';
import type { TemplateId } from '../../lib/newsletter/types';
import { TEMPLATES } from '../../lib/newsletter/templates';
import { TEMPLATE_NAME } from '../../lib/newsletter/render';
import type { Issue, IssueStatus, NewslettersApi, NlList, NlSettings } from '../../lib/newslettersApi';
import { NewslettersError, STATUS_LABEL } from '../../lib/newslettersApi';
import { errorText } from '../Toast';
import { IssueEditor } from './IssueEditor';
import { SubscribersTab } from './SubscribersTab';
import { SettingsTab } from './SettingsTab';
import { AudiencesTab } from './AudiencesTab';

type Tab = 'issues' | 'audiences' | 'subscribers' | 'settings';
type Filter = 'drafts' | 'review' | 'scheduled' | 'sent' | 'all';

const IN: Record<Filter, IssueStatus[] | null> = {
  drafts: ['draft', 'approved', 'cancelled'], review: ['in_review'], scheduled: ['scheduled', 'sending', 'paused'], sent: ['sent'], all: null
};

interface Props {
  api: NewslettersApi | null;
  you: { email: string; name: string };
  canAssist: boolean;
  toast: (t: { text: string; error?: boolean }) => void;
}

const when = (t: number | null) => (t ? new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '');

export function NewslettersPage({ api, you, canAssist, toast }: Props) {
  const [tab, setTab] = useState<Tab>('issues');
  const [filter, setFilter] = useState<Filter>('all');
  const [data, setData] = useState<{ issues: Issue[]; lists: NlList[]; canManage: boolean; role: string } | null>(null);
  const [settings, setSettings] = useState<NlSettings | null>(null);
  const [err, setErr] = useState('');
  const [openId, setOpenId] = useState<number | null>(null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    if (!api) return;
    setErr('');
    api.overview().then(setData).catch(e => setErr(e instanceof NewslettersError && e.code === 'schema_outdated'
      ? 'Newsletters need the database update (migration 0014). An administrator runs the pending migrations: npm run db:migrate.'
      : errorText(e)));
    api.settings().then(setSettings).catch(() => {});
  }, [api]);
  useEffect(load, [load]);

  const shown = useMemo(() => (data ? data.issues.filter(i => !IN[filter] || IN[filter]!.includes(i.status)) : []), [data, filter]);
  const say = (text: string, error = false) => toast({ text, error });

  const page = (body: React.ReactNode) => (
    <section className="admin" aria-label="Newsletters">
      <div className="page-inner" style={{ gap: 14, maxWidth: openId ? 1400 : undefined }}>
        {!openId && (
          <div className="page-title">
            <span className="mono-label">Workspace</span>
            <h1>Newsletters</h1>
            <span className="muted">Write newsletters from the Axal VC templates, get them approved, and send them to subscribers who opted in.</span>
          </div>
        )}
        {body}
      </div>
    </section>
  );

  if (!api) return page(<div className="card panel"><span className="muted">Newsletters need the Axal VC Mail backend (sign in with Google).</span></div>);

  if (openId && data) {
    return page(
      <IssueEditor key={openId} api={api} id={openId} lists={data.lists} settings={settings} you={you} canManage={data.canManage} canAssist={canAssist}
        toast={say} onClose={() => { setOpenId(null); load(); }}
        onChanged={i => setData(d => d && (i
          ? { ...d, issues: d.issues.some(x => x.id === i.id) ? d.issues.map(x => (x.id === i.id ? i : x)) : [i, ...d.issues] }
          : { ...d, issues: d.issues.filter(x => x.id !== openId) }))} />
    );
  }

  const manage = !!data?.canManage;
  const tabs: [Tab, string][] = [['issues', 'Newsletters'], ['audiences', 'Audiences'], ...(manage ? [['subscribers', 'Subscribers'], ['settings', 'Settings']] as [Tab, string][] : [])];
  const count = (f: Filter) => (data ? data.issues.filter(i => !IN[f] || IN[f]!.includes(i.status)).length : 0);

  const create = async (t: TemplateId) => {
    setBusy(true);
    try {
      const i = await api.create(t);
      setPicking(false);
      setData(d => d && { ...d, issues: [i, ...d.issues] });
      setOpenId(i.id);
    } catch (e) { say(errorText(e), true); } finally { setBusy(false); }
  };

  return page(
    <>
      <div className="an-tabs" role="tablist" aria-label="Newsletters sections">
        {tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={'btn sm' + (tab === k ? ' primary' : ' ghost')} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {err && <div className="notice warn" role="alert">{err} <button className="link-btn" onClick={load}>Try again</button></div>}
      {manage && settings && !settings.postalAddress && tab !== 'settings' && (
        <div className="notice accent">Add the firm’s postal address in Settings before the first send: every newsletter must carry it. <button className="link-btn" onClick={() => setTab('settings')}>Open Settings</button></div>
      )}

      {tab === 'issues' && (
        <>
          <div className="row-wrap" style={{ alignItems: 'center' }}>
            <div className="seg" role="tablist" aria-label="Filter">
              {([['all', 'All'], ['drafts', 'Drafts'], ['review', 'Awaiting approval'], ['scheduled', 'Scheduled'], ['sent', 'Sent']] as [Filter, string][]).map(([k, l]) => (
                <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>{l} {count(k) ? '· ' + count(k) : ''}</button>
              ))}
            </div>
            <span style={{ flex: 1 }} />
            <button className="btn ghost sm" aria-label="Refresh" onClick={load}>↻</button>
            <button className="btn primary sm" onClick={() => setPicking(true)}>New newsletter</button>
          </div>

          {picking && (
            <div className="card panel">
              <div className="row-wrap" style={{ alignItems: 'center' }}><b>Start from a template</b><span style={{ flex: 1 }} /><button className="btn ghost sm" onClick={() => setPicking(false)}>Cancel</button></div>
              <div className="nl-templates">
                {TEMPLATES.map(t => (
                  <button key={t.id} className="nl-template" disabled={busy} onClick={() => create(t.id)}>
                    <b>{t.name}</b>
                    <span className="muted">{t.description}</span>
                    <span className="faint">{t.audience}{t.id === 'letter' ? ' · approval always required' : ''}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {!data && !err && <div className="card panel an-loading"><div className="spinner" /> Loading…</div>}
          {data && (shown.length ? (
            <div className="card table table-scroll" aria-label="Newsletters">
              <div className="trow nl-issues head"><span>NEWSLETTER</span><span>AUDIENCE</span><span>AUTHOR</span><span>STATUS</span><span>CHANGED</span></div>
              {shown.map(i => (
                <button key={i.id} className="trow nl-issues link-like" onClick={() => setOpenId(i.id)}>
                  <span className="user-cell"><b>{i.title}</b><span>{TEMPLATE_NAME[i.template]}{i.subject ? ' · ' + i.subject : ''}</span></span>
                  <span className="muted">{i.listIds.map(id => data.lists.find(l => l.id === id)?.name).filter(Boolean).join(', ') || '—'}</span>
                  <span className="muted">{i.createdBy.split('@')[0]}</span>
                  <span>
                    <span className={'pill' + (i.status === 'sent' ? ' ok' : i.status === 'in_review' || i.status === 'paused' ? ' warn' : ['approved', 'scheduled', 'sending'].includes(i.status) ? ' accent' : '')}>
                      {STATUS_LABEL[i.status]}{i.status === 'sending' ? ' ' + i.sent + '/' + i.recipients : ''}
                    </span>
                  </span>
                  <span className="muted">{i.status === 'sent' ? when(i.sentAt) : i.status === 'scheduled' ? when(i.scheduledAt) : when(i.updatedAt)}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="card panel"><span className="faint">{data.issues.length ? 'No newsletters here.' : 'No newsletters yet. Start from a template.'}</span></div>
          ))}
        </>
      )}

      {tab === 'audiences' && data && <AudiencesTab api={api} lists={data.lists} canManage={manage} superAdmin={data.role === 'super_admin'} onLists={lists => setData(d => d && { ...d, lists })} toast={say} />}
      {tab === 'subscribers' && manage && data && <SubscribersTab api={api} lists={data.lists} toast={say} />}
      {tab === 'settings' && manage && settings && (
        <SettingsTab api={api} settings={settings} you={you.email} superAdmin={data?.role === 'super_admin'} onSaved={setSettings} toast={say} />
      )}
    </>
  );
}
