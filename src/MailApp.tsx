import { useCallback, useEffect, useRef, useState } from 'react';
import type { Account, AiInsight, Folder, AttachmentRef, Category, Identity, Mailbox, OutgoingMessage, SentResult, Thread, ThreadSummary } from './types';
import type { FolderCounts, MailProvider } from './providers/types';
import type { Assistant } from './assistant/types';
import { Header } from './components/Header';
import { Sidebar, VIEW_TITLES, type View } from './components/Sidebar';
import { ThreadList } from './components/ThreadList';
import { ThreadReader } from './components/ThreadReader';
import { AssistantPanel } from './components/AssistantPanel';
import { Composer, type ComposerHandle } from './components/composer/Composer';
import { forwardSubject, newCompose, replySubject, type ComposeState } from './components/composer/state';
import { BulkEmail } from './components/bulk/BulkEmail';
import { SignatureAdmin } from './components/admin/SignatureAdmin';
import { MembersAdmin } from './components/admin/MembersAdmin';
import { ROLE_LABEL, type AdminApi, type Role } from './admin/api';
import { BugReportDialog } from './components/BugReportDialog';
import { Analytics, type Deliverability } from './components/analytics/Analytics';
import { Automations } from './components/automations/Automations';
import { Sequences } from './components/automations/Sequences';
import type { SequencesApi } from './lib/sequencesApi';
import type { NotesStore } from './providers/gmail/notes';
import { InternalPage } from './components/internal/InternalPage';
import type { ReportBug } from './lib/diagnostics';
import { errorText, useToast } from './components/Toast';
import { escapeHtml, textToHtml } from './lib/html';
import { plural } from './lib/format';

const LIST_VIEWS = new Set<View>(['inbox', 'starred', 'snoozed', 'sent', 'drafts', 'scheduled', 'all', 'search']);
const EMPTY_COUNTS: FolderCounts = { inbox: 0, snoozed: 0, sent: 0, drafts: 0, scheduled: 0 };

const isNarrow = () => typeof window !== 'undefined' && window.matchMedia?.('(max-width: 760px)').matches;

interface Props {
  provider: MailProvider;
  assistant: Assistant;
  signOutLabel: string;
  onSignOut: () => void;
  /** The signed-in member's role, once known. */
  role?: Role | null;
  /** Members & access administration (admins only). */
  admin?: AdminApi | null;
  /** Open another mailbox; `own` is the user's own address. Without it, picking only relabels (demo). */
  onSwitchMailbox?: (addr: string, own: string) => void;
  /** Files a bug report as a GitHub issue; absent when the backend has none set up. */
  reportBug?: ReportBug | null;
  /** DNS sender-authentication check for the organization's domain (backend). */
  deliverability?: Deliverability | null;
  /** Outreach sequences (backend). */
  sequences?: SequencesApi | null;
  /** Internal notes and comments (backend, or this device). */
  notes?: NotesStore | null;
}

interface ListState {
  threads: ThreadSummary[];
  next?: string;
  loading: boolean;
  error: string | null;
}

interface OpenOpts {
  replyTo?: Thread;
  all?: boolean;
  ai?: boolean;
  forward?: Thread;
  draftId?: string;
}

export function MailApp({ provider, assistant, signOutLabel, onSignOut, role, admin, onSwitchMailbox, reportBug, deliverability, sequences, notes }: Props) {
  const toast = useToast();
  const [boot, setBoot] = useState<{ account: Account; identities: Identity[]; mailboxes: Mailbox[]; categories: Category[] } | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);

  const [view, setView] = useState<View>('inbox');
  const [category, setCategory] = useState('');
  const [query, setQuery] = useState('');
  const [mailbox, setMailbox] = useState('');
  const [list, setList] = useState<ListState>({ threads: [], loading: true, error: null });
  const [counts, setCounts] = useState<FolderCounts>(EMPTY_COUNTS);
  const [selId, setSelId] = useState<string | null>(null);
  const [thread, setThread] = useState<Thread | null>(null);
  const [threadState, setThreadState] = useState<{ loading: boolean; error: string | null }>({ loading: false, error: null });
  const [aiOpen, setAiOpen] = useState(() => typeof window !== 'undefined' && window.innerWidth >= 1280);
  const [insight, setInsight] = useState<{ id: string; data: AiInsight | null; loading: boolean } | null>(null);
  const [compose, setCompose] = useState<ComposeState | null>(null);
  const [navOpen, setNavOpen] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  const [bugOpen, setBugOpen] = useState(false);
  const [internalUnread, setInternalUnread] = useState(0);
  const refreshInternal = useCallback(() => {
    notes?.inbox?.().then(r => setInternalUnread(r.unread)).catch(() => {});
  }, [notes]);
  useEffect(() => {
    refreshInternal();
    const t = setInterval(refreshInternal, 120_000);
    return () => clearInterval(t);
  }, [refreshInternal]);

  const composerRef = useRef<ComposerHandle>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listReq = useRef(0);
  const autoSelect = useRef(true);

  // ----- boot -----
  const load = useCallback(async () => {
    setBootError(null);
    try {
      const [account, identities, mailboxes, categories] = await Promise.all([
        provider.account(), provider.identities(), provider.mailboxes(), provider.categories()
      ]);
      setBoot({ account, identities, mailboxes, categories });
      setMailbox(m => m || provider.mailbox || account.email);
      setCategory(c => c || categories[0]?.id || '');
    } catch (e) {
      setBootError(errorText(e));
    }
  }, [provider]);
  useEffect(() => { load(); }, [load]);

  const refreshCounts = useCallback(() => {
    provider.counts().then(setCounts).catch(() => {});
  }, [provider]);
  useEffect(() => { if (boot) refreshCounts(); }, [boot, refreshCounts]);

  // ----- list -----
  const isList = LIST_VIEWS.has(view);
  const fetchList = useCallback(async (pageToken?: string) => {
    if (!boot || !isList) return;
    const req = ++listReq.current;
    setList(l => ({ ...l, loading: true, error: null }));
    try {
      const page = await provider.listThreads({ folder: view as Folder, category, query, pageToken });
      if (req !== listReq.current) return;
      setList(l => ({ threads: pageToken ? [...l.threads, ...page.threads] : page.threads, next: page.nextPageToken, loading: false, error: null }));
      if (!pageToken && autoSelect.current) {
        autoSelect.current = false;
        const first = page.threads.find(t => !t.draftId);
        if (first && !isNarrow()) setSelId(first.id);
      }
    } catch (e) {
      if (req === listReq.current) setList(l => ({ ...l, loading: false, error: errorText(e) }));
    }
  }, [boot, isList, provider, view, category, query]);

  useEffect(() => { fetchList(); }, [fetchList, reloadTick]);

  const reload = useCallback(() => { setReloadTick(t => t + 1); refreshCounts(); }, [refreshCounts]);

  // ----- selected thread -----
  useEffect(() => {
    if (!selId) { setThread(null); return; }
    let live = true;
    setThreadState({ loading: true, error: null });
    setThread(t => (t?.id === selId ? t : null));
    provider.getThread(selId).then(t => {
      if (!live) return;
      setThread(t);
      setThreadState({ loading: false, error: null });
      if (t.unread) {
        setList(l => ({ ...l, threads: l.threads.map(x => (x.id === t.id ? { ...x, unread: false } : x)) }));
        provider.markRead(t.id, true).then(refreshCounts).catch(() => {});
      }
    }).catch(e => live && setThreadState({ loading: false, error: errorText(e) }));
    return () => { live = false; };
  }, [selId, provider, refreshCounts, reloadTick]);

  useEffect(() => {
    if (!aiOpen || !thread) return;
    if (insight?.id === thread.id) return;
    let live = true;
    setInsight({ id: thread.id, data: null, loading: true });
    assistant.insight(thread)
      .then(data => live && setInsight({ id: thread.id, data, loading: false }))
      .catch(() => live && setInsight({ id: thread.id, data: null, loading: false }));
    return () => { live = false; };
  }, [aiOpen, thread, assistant]); // insight is a cache keyed by thread id; reading it must not re-run this

  // ----- navigation -----
  /** Switch view; `select` opens a specific conversation instead of the first one. */
  const go = (v: View, select?: string) => {
    setNavOpen(false);
    if (v === 'bulk' || v === 'admin' || v === 'members' || v === 'sequences') setCompose(c => (c ? { ...c, minimized: true } : c));
    if (v !== 'search') setQuery('');
    autoSelect.current = !select;
    setSelId(select || null);
    setList({ threads: [], loading: true, error: null });
    setView(v);
  };

  const onSearch = (q: string) => {
    if (!q) return go('inbox');
    autoSelect.current = true;
    setSelId(null);
    setList({ threads: [], loading: true, error: null });
    setQuery(q);
    setView('search');
  };

  // ----- compose -----
  const updateCompose = useCallback((p: Partial<ComposeState> | ((c: ComposeState) => Partial<ComposeState>)) => {
    setCompose(c => (c ? { ...c, ...(typeof p === 'function' ? p(c) : p) } : c));
  }, []);

  const openCompose = async (o: OpenOpts = {}) => {
    if (!boot) return;
    if (compose && !o.replyTo && !o.forward && !o.draftId) { updateCompose({ minimized: false }); return; }
    if (compose) {
      const ok = await composerRef.current?.close(true);
      if (ok === false) return;
    }
    const { identities, account } = boot;
    const mine = new Set(identities.map(i => i.addr.toLowerCase()));
    const byMailbox = identities.find(i => i.addr === mailbox);
    const fallbackId = (byMailbox || identities.find(i => i.isDefault) || identities[0]).id;

    if (o.draftId) {
      try {
        const d = await provider.getDraft(o.draftId);
        const fromId = identities.find(i => i.addr.toLowerCase() === d.identityAddr?.toLowerCase())?.id || fallbackId;
        setCompose(newCompose({
          fromId, draftId: d.draftId, to: d.to, cc: d.cc, bcc: d.bcc, showCc: d.cc.length > 0, showBcc: d.bcc.length > 0,
          subject: d.subject, html: d.html, attachments: d.attachments, reply: d.reply ?? null, mode: d.reply ? 'reply' : 'new',
          note: d.note || '', noteOpen: !!d.note, priority: d.priority || 'Normal', savedAt: 'earlier'
        }));
      } catch (e) {
        toast({ text: 'Could not open the draft: ' + errorText(e), error: true });
      }
      return;
    }

    const t = o.replyTo || o.forward;
    if (!t) { setCompose(newCompose({ fromId: fallbackId })); return; }
    const msgs = t.messages;
    const last = msgs[msgs.length - 1];
    if (o.replyTo && last) {
      const incoming = [...msgs].reverse().find(m => !mine.has(m.email.toLowerCase())) || last;
      const to = [{ name: incoming.from, email: incoming.email, org: t.org }];
      const addressedTo = (incoming.recipients || []).find(r => mine.has(r.email.toLowerCase()));
      const fromId = addressedTo ? identities.find(i => i.addr.toLowerCase() === addressedTo.email.toLowerCase())!.id : fallbackId;
      const me = (identities.find(i => i.id === fromId)?.addr || account.email).toLowerCase();
      const cc = o.all
        ? (incoming.recipients || []).filter(r => r.email.toLowerCase() !== me && r.email.toLowerCase() !== incoming.email.toLowerCase() && r.email.toLowerCase() !== account.email.toLowerCase())
        : [];
      const draft = o.ai && insight?.id === t.id ? insight.data?.draft : undefined;
      setCompose(newCompose({
        mode: 'reply', fromId, to, cc, showCc: cc.length > 0, subject: replySubject(t.subject), context: t,
        reply: { threadId: t.id, messageIdHeader: incoming.messageIdHeader, references: incoming.references, rootId: msgs[0]?.messageIdHeader },
        quote: { who: incoming.from, time: incoming.time, text: incoming.text },
        html: draft || '', aiBar: !!o.ai,
        aiNote: draft ? { title: 'AI draft.', text: 'Based on this thread only. Review before sending.' } : null
      }));
      return;
    }
    if (o.forward && last) {
      const head = '<p><br></p><p>---------- Forwarded message ---------<br>From: ' + escapeHtml(last.from) + ' &lt;' + escapeHtml(last.email) + '&gt;<br>' +
        'Date: ' + escapeHtml(last.time) + '<br>Subject: ' + escapeHtml(t.subject) + '<br>To: ' + escapeHtml(last.to) + '</p>';
      setCompose(newCompose({
        mode: 'forward', fromId: fallbackId, subject: forwardSubject(t.subject), context: t,
        html: head + '<blockquote>' + textToHtml(last.text) + '</blockquote>',
        forwardable: last.attachments
      }));
    }
  };

  const onSent = (r: SentResult, msg: OutgoingMessage) => {
    reload();
    if (provider.capabilities.demo) {
      if (r.scheduled) toast({ text: 'Scheduled for ' + msg.schedule!.when + '. Demo mode: it will not be sent.', action: 'View', onAction: () => go('scheduled', r.id) });
      else toast({ text: 'Recorded in demo mode. Not delivered.', action: 'View in Sent', onAction: () => go('sent', r.id) });
    } else {
      toast({ text: 'Message sent.', action: 'View', onAction: () => go('sent', r.threadId) });
    }
  };

  // ----- global shortcuts -----
  const openRef = useRef(openCompose);
  openRef.current = openCompose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const typing = /^(input|textarea|select)$/i.test(el.tagName || '') || el.isContentEditable;
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'c' || e.key === 'C') { e.preventDefault(); openRef.current({}); }
      if (e.key === '/') { e.preventDefault(); searchRef.current?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ----- thread actions -----
  const removeFromList = (id: string) => {
    const idx = list.threads.findIndex(x => x.id === id);
    const threads = list.threads.filter(x => x.id !== id);
    const next = threads[Math.min(idx, threads.length - 1)];
    setList(l => ({ ...l, threads: l.threads.filter(x => x.id !== id) }));
    setSelId(next && !isNarrow() ? next.id : null);
  };

  const act = async (fn: () => Promise<unknown>, done: string, remove = true) => {
    if (!thread) return;
    const id = thread.id;
    try {
      await fn();
      if (remove) removeFromList(id);
      toast(done);
      refreshCounts();
    } catch (e) {
      toast({ text: errorText(e), error: true });
    }
  };

  const star = async (t: ThreadSummary) => {
    const v = !t.starred;
    setList(l => ({ ...l, threads: l.threads.map(x => (x.id === t.id ? { ...x, starred: v } : x)) }));
    try { await provider.setStarred(t.id, v); } catch (e) {
      setList(l => ({ ...l, threads: l.threads.map(x => (x.id === t.id ? { ...x, starred: !v } : x)) }));
      toast({ text: errorText(e), error: true });
    }
  };

  const download = async (a: AttachmentRef) => {
    try {
      const blob = await provider.downloadAttachment(a.messageId || '', a.attachmentId || '', a.mime);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = a.name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      toast({ text: 'Download failed: ' + errorText(e), error: true });
    }
  };

  // ----- render -----
  if (bootError) {
    return (
      <div className="connect">
        <div className="card connect-card">
          <h1>Could not load your mailbox</h1>
          <p className="tone-danger">{bootError}</p>
          <div className="row-wrap">
            <button className="btn primary lg" onClick={load}>Try again</button>
            <button className="btn lg" onClick={onSignOut}>{signOutLabel}</button>
          </div>
        </div>
      </div>
    );
  }
  if (!boot) return <div className="connect"><div className="spinner" aria-label="Loading" /></div>;

  const demo = provider.capabilities.demo;
  const title = view === 'search' ? 'Search: ' + query : VIEW_TITLES[view];
  const meta = view === 'inbox'
    ? counts.inbox + ' unread · ' + mailbox
    : plural(list.threads.length, 'conversation') + (list.next ? '+' : '');

  return (
    <div className="shell">
      {demo && (
        <div className="banner">
          <span className="mono-label">Demo mode</span>
          <span>Fictional sample data. Sending records the message here only; nothing is delivered.</span>
        </div>
      )}
      <Header
        account={boot.account} mailbox={mailbox} mailboxes={boot.mailboxes} query={query} searchRef={searchRef} signOutLabel={signOutLabel}
        onPickMailbox={addr => (onSwitchMailbox && addr !== mailbox ? onSwitchMailbox(addr, boot.account.email) : setMailbox(addr))} onSearch={onSearch} onToggleAssistant={() => setAiOpen(o => !o)} onBulk={() => go('bulk')}
        onCompose={() => openCompose({})} onToggleNav={() => setNavOpen(o => !o)} onSignOut={onSignOut}
        onReportBug={reportBug ? () => setBugOpen(true) : undefined}
      />
      <div className="body">
        <Sidebar view={view} counts={{ ...counts, internal: internalUnread }} open={navOpen} hide={{ members: !admin && !demo }} onGo={go} onCompose={() => openCompose({})}
          footer={demo ? 'Signed in with your Axal VC account' : (provider.mailbox ? 'Shared mailbox · ' + provider.mailbox : 'Connected to Gmail · ' + boot.account.email) + (role && role !== 'member' ? ' · ' + ROLE_LABEL[role] : '')} />
        <main className={'main' + (selId ? ' has-sel' : '')} onClick={() => navOpen && setNavOpen(false)}>
          {isList && (
            <>
              <ThreadList
                title={title} meta={meta} categories={view === 'inbox' ? boot.categories : null} category={category}
                threads={list.threads} selectedId={selId} loading={list.loading} error={list.error} hasMore={!!list.next}
                onCategory={id => { autoSelect.current = true; setSelId(null); setList({ threads: [], loading: true, error: null }); setCategory(id); }}
                onOpen={t => (t.draftId ? openCompose({ draftId: t.draftId }) : setSelId(t.id))}
                onStar={star} onMore={() => fetchList(list.next)} onRefresh={reload}
              />
              <ThreadReader
                thread={thread} loading={threadState.loading} error={threadState.error} canSnooze={provider.capabilities.snooze} demoMode={demo}
                onBack={() => setSelId(null)}
                onReply={all => thread && openCompose({ replyTo: thread, all })}
                onForward={() => thread && openCompose({ forward: thread })}
                onArchive={() => act(() => provider.archive(thread!.id), 'Archived')}
                onDelete={() => act(() => provider.trash(thread!.id), demo ? 'Deleted' : 'Moved to Trash')}
                onSnooze={() => thread && provider.snooze(thread.id).then(until => { removeFromList(thread.id); toast('Snoozed until ' + until); refreshCounts(); }).catch(e => toast({ text: errorText(e), error: true }))}
                onDownload={download}
                internal={notes ? { store: notes, authorName: boot.account.name, onChanged: refreshInternal } : null}
              />
              {aiOpen && (
                <AssistantPanel
                  insight={thread && insight?.id === thread.id ? insight.data : null}
                  loading={!!thread && insight?.id === thread.id && insight.loading}
                  emptyText={!thread ? 'Select a conversation to see a summary.' : assistant.unavailableText}
                  onClose={() => setAiOpen(false)}
                  onDraft={() => thread && openCompose({ replyTo: thread, ai: true })}
                  onFollowUp={() => {
                    if (demo) return toast('Follow-up task created for Monday');
                    if (thread) act(() => provider.setStarred(thread.id, true), 'Starred to follow up', false);
                  }}
                />
              )}
            </>
          )}
          {view === 'bulk' && (
            <BulkEmail provider={provider} assistant={assistant} account={boot.account} identities={boot.identities}
              onDone={(folder) => { reload(); go(folder); }} />
          )}
          {view === 'admin' && <SignatureAdmin provider={provider} onProfileChanged={load} />}
          {view === 'members' && <MembersAdmin api={admin || null} role={role || 'member'} demo={demo} />}
          {view === 'analytics' && (
            <Analytics provider={provider} orgDomain={provider.orgDomain || boot.account.email.split('@')[1] || ''}
              deliverability={deliverability} onOpen={id => go('inbox', id)} />
          )}
          {view === 'automations' && (
            <Automations provider={provider} orgDomain={provider.orgDomain || boot.account.email.split('@')[1] || ''} aiReady={assistant.live}
              onOpen={id => go('inbox', id)} onGo={go}
              onDraftReply={id => provider.getThread(id).then(t => openCompose({ replyTo: t, ai: true })).catch(e => toast({ text: errorText(e), error: true }))} />
          )}
          {view === 'internal' && (
            <InternalPage store={notes || null} onChanged={refreshInternal}
              onOpen={async key => {
                const id = await provider.findThread?.(key).catch(() => null);
                if (id) go('inbox', id);
                else toast({ text: 'That conversation isn’t in this mailbox. It may be in a teammate’s or a shared mailbox.', error: true });
              }} />
          )}
          {view === 'sequences' && <Sequences api={sequences || null} profile={boot.account.profile} onBack={() => go('automations')} />}
          {!isList && !['bulk', 'admin', 'members', 'analytics', 'automations', 'sequences', 'internal'].includes(view) && (
            <section className="placeholder">
              <h1>{VIEW_TITLES[view]}</h1>
              <span className="muted">Not part of this build yet. This pass covers the mailbox, reader, composer, bulk email and signatures.</span>
            </section>
          )}
        </main>
      </div>
      {bugOpen && reportBug && <BugReportDialog view={view} report={reportBug} onClose={() => setBugOpen(false)} />}
      {compose && (
        <Composer
          key={compose.key}
          compose={compose}
          update={updateCompose}
          provider={provider}
          assistant={assistant}
          account={boot.account}
          identities={boot.identities}
          handleRef={composerRef}
          onClosed={() => setCompose(null)}
          onSent={onSent}
          onDraftsChanged={() => { refreshCounts(); if (view === 'drafts') setReloadTick(t => t + 1); }}
          onOpenDraft={id => openCompose({ draftId: id })}
        />
      )}
    </div>
  );
}
