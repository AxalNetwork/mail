import { useEffect, useMemo, useState } from 'react';
import { loadConfig, type AppConfig } from './config';
import { MailApp } from './MailApp';
import { ToastProvider } from './components/Toast';
import { LoginScreen, type LoginReason } from './components/LoginScreen';
import { DemoProvider } from './providers/demo/DemoProvider';
import { ORG_DOMAIN as DEMO_DOMAIN } from './providers/demo/data';
import { GmailProvider } from './providers/gmail/GmailProvider';
import { GoogleAuth } from './providers/gmail/auth';
import { LocalNotes, RemoteNotes, type NotesStore } from './providers/gmail/notes';
import type { MailProvider } from './providers/types';
import { DemoAssistant } from './assistant/demo';
import { HttpAssistant } from './assistant/http';
import { OfflineAssistant } from './assistant/offline';
import type { Assistant } from './assistant/types';
import { demoSignIn, fetchMe, gmailSignIn } from './signIn';
import { HttpAdminApi, type AdminApi, type Role } from './admin/api';
import { httpReportBug, type ReportBug } from './lib/diagnostics';
import { HttpSequencesApi, SENDER_SCOPES, type SequencesApi } from './lib/sequencesApi';
import { requestOfflineCode } from './providers/gmail/auth';
import { HttpDismissals, type DismissalStore } from './lib/automationsApi';
import { HttpContactsApi, type ContactsApi } from './lib/contactsApi';
import { HttpSharedApi, type SharedApi } from './lib/sharedApi';
import { HttpSnoozes, LocalSnoozes } from './lib/snooze';
import { Documents, httpExtractor } from './lib/documents';
import { Drive } from './lib/drive';
import { DriveAuth } from './providers/gmail/driveAuth';

type Mode = 'login' | 'demo' | 'gmail';

interface Session {
  provider: MailProvider;
  assistant: Assistant;
  notes?: NotesStore;
}

/** Shared mailboxes this member may open (backend), or none without one. */
async function sharedMailboxes(auth: GoogleAuth, config: AppConfig): Promise<string[]> {
  if (!config.sessionUrl) return [];
  const res = await fetch('/api/mailboxes', { headers: { Authorization: 'Bearer ' + (await auth.token()) } });
  if (!res.ok) return [];
  return ((await res.json()) as { mailboxes?: string[] }).mailboxes || [];
}

function gmailSession(auth: GoogleAuth, config: AppConfig, mailbox: string | null): Session {
  const notes = config.notesUrl ? new RemoteNotes(config.notesUrl, () => auth.token()) : new LocalNotes();
  const provider = new GmailProvider(auth, config.orgDomain, notes, {
    mailbox: mailbox || undefined,
    proxyBase: location.origin + '/api/mailboxes',
    sharedMailboxes: () => sharedMailboxes(auth, config),
    snoozes: config.sessionUrl ? new HttpSnoozes(() => auth.token()) : new LocalSnoozes()
  });
  const assistant = config.assistantUrl
    ? new HttpAssistant(config.assistantUrl, () => auth.token().catch(() => null))
    : new OfflineAssistant();
  return { provider, assistant, notes };
}

export function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  useEffect(() => { loadConfig().then(setConfig); }, []);
  if (!config) return <div className="connect"><div className="spinner" aria-label="Loading" /></div>;
  return (
    <ToastProvider>
      <Root config={config} />
    </ToastProvider>
  );
}

/**
 * The simulated sign-in and sample data exist only in local development
 * (`npm run dev`). A deployed build never lets anyone in without a verified
 * Google account, and has no demo mode.
 */
const DEMO_ALLOWED = import.meta.env.DEV;

function NotConfigured() {
  return (
    <div className="connect">
      <div className="card connect-card" role="alert">
        <span className="mono-label">Axal VC Mail</span>
        <h1>Sign-in isn't set up yet</h1>
        <p>This deployment has no Google OAuth client ID, so nobody can sign in. An administrator needs to set
          <code> GOOGLE_CLIENT_ID</code> (or <code>GMAIL_CLIENT_ID</code>) on the <code>mail</code> Worker.</p>
      </div>
    </div>
  );
}

function Root({ config }: { config: AppConfig }) {
  if (!config.googleClientId && !DEMO_ALLOWED) return <NotConfigured />;
  return <Session config={config} />;
}

function Session({ config }: { config: AppConfig }) {
  // Without a Google client ID the deployment is a demo: sign-in is simulated.
  const auth = useMemo(() => (config.googleClientId ? new GoogleAuth(config.googleClientId) : null), [config]);
  const [mode, setMode] = useState<Mode>(() => (auth?.hasValidToken() ? 'gmail' : 'login'));
  const [reason, setReason] = useState<LoginReason>(() => (auth?.sessionExpired() ? 'expired' : 'signed-out'));
  const [nonce, setNonce] = useState(0);
  const [role, setRole] = useState<Role | null>(null);
  /** Shared mailbox being shown; null = the user's own. */
  const [shared, setShared] = useState<string | null>(null);
  /** Conversation to open after switching to a shared mailbox from Shared Inboxes. */
  const [openThread, setOpenThread] = useState<string | null>(null);

  useEffect(() => {
    if (!auth) return;
    auth.onSessionLost = (why) => {
      setReason(why);
      setMode('login');
    };
    return () => { auth.onSessionLost = null; };
  }, [auth]);

  // Enforce the 12-hour session even while the app sits idle.
  useEffect(() => {
    if (!auth || mode !== 'gmail') return;
    const t = setInterval(() => {
      if (!auth.sessionExpired()) return;
      auth.invalidate();
      setReason('expired');
      setMode('login');
    }, 60_000);
    return () => clearInterval(t);
  }, [auth, mode]);

  // A session restored from a previous visit skipped the login screen: the
  // mailbox stays hidden until the backend confirms an active member.
  const [checkFailed, setCheckFailed] = useState(false);
  useEffect(() => {
    if (mode !== 'gmail' || !auth || role || !config.sessionUrl) return;
    let live = true;
    setCheckFailed(false);
    auth.token()
      .then(t => fetchMe(config.sessionUrl, t))
      .then(me => {
        if (!live) return;
        if (me === 'denied') {
          auth.signOut();
          setReason('lost');
          setMode('login');
        } else if (me) setRole(me.role);
        else setCheckFailed(true);
      })
      .catch(() => live && setCheckFailed(true));
    return () => { live = false; };
  }, [mode, auth, role, config.sessionUrl, nonce]);

  const session = useMemo<Session | null>(() => {
    if (mode === 'demo') return { provider: new DemoProvider(), assistant: new DemoAssistant() };
    if (mode === 'gmail' && auth) return gmailSession(auth, config, shared);
    return null;
  }, [mode, auth, config, nonce, shared]); // a new nonce starts a fresh session (e.g. after signing out of the demo)

  const admin = useMemo<AdminApi | null>(
    () => (mode === 'gmail' && auth && config.sessionUrl && (role === 'admin' || role === 'super_admin') ? new HttpAdminApi('/api/admin', () => auth.token()) : null),
    [mode, auth, config.sessionUrl, role]
  );

  const reportBug = useMemo<ReportBug | null>(
    () => (mode === 'gmail' && auth && config.bugReportUrl ? httpReportBug(config.bugReportUrl, () => auth.token()) : null),
    [mode, auth, config.bugReportUrl]
  );

  const sequences = useMemo<SequencesApi | null>(
    () => (mode === 'gmail' && auth && config.sessionUrl
      ? new HttpSequencesApi(() => auth.token(), () => requestOfflineCode(config.googleClientId, SENDER_SCOPES, auth.loginHint))
      : null),
    [mode, auth, config.sessionUrl, config.googleClientId]
  );

  const dismissals = useMemo<DismissalStore | null>(
    () => (mode === 'gmail' && auth && config.sessionUrl ? new HttpDismissals(() => auth.token()) : null),
    [mode, auth, config.sessionUrl]
  );

  const sharedApi = useMemo<SharedApi | null>(
    () => (mode === 'gmail' && auth && config.sessionUrl ? new HttpSharedApi(() => auth.token()) : null),
    [mode, auth, config.sessionUrl]
  );

  const contacts = useMemo<ContactsApi | null>(
    () => (mode === 'gmail' && auth && config.sessionUrl ? new HttpContactsApi(() => auth.token()) : null),
    [mode, auth, config.sessionUrl]
  );

  // Documents: the member's own Drive, asked for separately (scope drive.file) when they turn it on.
  const documents = useMemo(() => {
    if (mode !== 'gmail' || !auth || !config.sessionUrl || !config.googleClientId || !session) return null;
    const driveAuth = new DriveAuth(config.googleClientId, () => auth.loginHint);
    return new Documents(new Drive(driveAuth), driveAuth, () => session.provider.account().then(a => a.email), config.assistantUrl ? httpExtractor(() => auth.token()) : undefined);
  }, [mode, auth, config.sessionUrl, config.googleClientId, config.assistantUrl, session]);

  const outreach = useMemo(
    () => (mode === 'gmail' && auth && config.sessionUrl
      ? async (from: number, to: number) => {
        const res = await fetch('/api/analytics/outreach?from=' + from + '&to=' + to, { headers: { Authorization: 'Bearer ' + (await auth.token()) } });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error((j as { error?: string }).error || 'Outreach figures failed (' + res.status + ')');
        return j as Awaited<ReturnType<NonNullable<React.ComponentProps<typeof MailApp>['outreach']>>>;
      }
      : null),
    [mode, auth, config.sessionUrl]
  );

  const deliverability = useMemo(
    () => (mode === 'gmail' && auth && config.sessionUrl
      ? async () => {
        const res = await fetch('/api/analytics/deliverability', { headers: { Authorization: 'Bearer ' + (await auth.token()) } });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error((j as { error?: string }).error || 'Deliverability check failed (' + res.status + ')');
        return j as Awaited<ReturnType<NonNullable<React.ComponentProps<typeof MailApp>['deliverability']>>>;
      }
      : null),
    [mode, auth, config.sessionUrl]
  );

  const signOut = () => {
    session?.provider.signOut?.();
    setReason('signed-out');
    setMode('login');
    setRole(null);
    setShared(null);
    setNonce(n => n + 1);
  };

  if (mode === 'login' || !session) {
    return (
      <LoginScreen
        orgDomain={auth ? config.orgDomain : DEMO_DOMAIN}
        reason={reason}
        simulated={!auth}
        signIn={async (o, checking) => {
          const who = await (auth ? gmailSignIn(auth, config, o, checking) : demoSignIn(o, checking));
          setRole(who.role || null);
          return who;
        }}
        onDone={() => { setReason('signed-out'); setMode(auth ? 'gmail' : 'demo'); }}
        onDemo={auth && DEMO_ALLOWED ? () => setMode('demo') : undefined}
      />
    );
  }

  if (mode === 'gmail' && config.sessionUrl && !role) {
    return (
      <div className="connect">
        {checkFailed
          ? (
            <div className="card connect-card">
              <h1>Couldn't reach Axal VC Mail</h1>
              <p>Your access couldn't be confirmed. Check your connection and try again.</p>
              <div className="row-wrap">
                <button className="btn primary lg" onClick={() => setNonce(n => n + 1)}>Try again</button>
                <button className="btn lg" onClick={signOut}>Sign out</button>
              </div>
            </div>
          )
          : <div className="spinner" aria-label="Checking your access" />}
      </div>
    );
  }

  return (
    <MailApp
      key={mode + nonce + (shared || '')}
      provider={session.provider}
      assistant={session.assistant}
      role={mode === 'demo' ? 'super_admin' : role}
      admin={admin}
      reportBug={reportBug}
      deliverability={deliverability}
      sequences={sequences}
      dismissals={dismissals}
      contacts={contacts}
      shared={sharedApi}
      providerFor={auth ? m => gmailSession(auth, config, m).provider : undefined}
      onOpenShared={(m, id) => { setOpenThread(id); setShared(m); }}
      initialThread={openThread}
      outreach={outreach}
      documents={documents}
      notes={session.notes || null}
      onSwitchMailbox={mode === 'gmail' ? (addr, own) => { setOpenThread(null); setShared(addr === own ? null : addr); } : undefined}
      signOutLabel={mode === 'gmail' ? 'Sign out' : auth ? 'Exit demo' : 'Sign out'}
      onSignOut={signOut}
    />
  );
}
