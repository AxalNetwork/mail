import { useEffect, useMemo, useState } from 'react';
import { loadConfig, type AppConfig } from './config';
import { MailApp } from './MailApp';
import { ToastProvider } from './components/Toast';
import { LoginScreen, type LoginReason } from './components/LoginScreen';
import { DemoProvider } from './providers/demo/DemoProvider';
import { ORG_DOMAIN as DEMO_DOMAIN } from './providers/demo/data';
import { GmailProvider } from './providers/gmail/GmailProvider';
import { GoogleAuth } from './providers/gmail/auth';
import { LocalNotes, RemoteNotes } from './providers/gmail/notes';
import type { MailProvider } from './providers/types';
import { DemoAssistant } from './assistant/demo';
import { HttpAssistant } from './assistant/http';
import { OfflineAssistant } from './assistant/offline';
import type { Assistant } from './assistant/types';
import { demoSignIn, fetchMe, gmailSignIn } from './signIn';
import { HttpAdminApi, type AdminApi, type Role } from './admin/api';

type Mode = 'login' | 'demo' | 'gmail';

interface Session {
  provider: MailProvider;
  assistant: Assistant;
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
    sharedMailboxes: () => sharedMailboxes(auth, config)
  });
  const assistant = config.assistantUrl
    ? new HttpAssistant(config.assistantUrl, () => auth.token().catch(() => null))
    : new OfflineAssistant();
  return { provider, assistant };
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

function Root({ config }: { config: AppConfig }) {
  // Without a Google client ID the deployment is a demo: sign-in is simulated.
  const auth = useMemo(() => (config.googleClientId ? new GoogleAuth(config.googleClientId) : null), [config]);
  const [mode, setMode] = useState<Mode>(() => (auth?.hasValidToken() ? 'gmail' : 'login'));
  const [reason, setReason] = useState<LoginReason>(() => (auth?.sessionExpired() ? 'expired' : 'signed-out'));
  const [nonce, setNonce] = useState(0);
  const [role, setRole] = useState<Role | null>(null);
  /** Shared mailbox being shown; null = the user's own. */
  const [shared, setShared] = useState<string | null>(null);

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

  // A session restored from a previous visit skips the login screen; ask the backend who this is.
  useEffect(() => {
    if (mode !== 'gmail' || !auth || role || !config.sessionUrl) return;
    let live = true;
    auth.token().then(t => fetchMe(config.sessionUrl, t)).then(me => live && me && setRole(me.role)).catch(() => {});
    return () => { live = false; };
  }, [mode, auth, role, config.sessionUrl]);

  const session = useMemo<Session | null>(() => {
    if (mode === 'demo') return { provider: new DemoProvider(), assistant: new DemoAssistant() };
    if (mode === 'gmail' && auth) return gmailSession(auth, config, shared);
    return null;
  }, [mode, auth, config, nonce, shared]); // a new nonce starts a fresh session (e.g. after signing out of the demo)

  const admin = useMemo<AdminApi | null>(
    () => (mode === 'gmail' && auth && config.sessionUrl && (role === 'admin' || role === 'super_admin') ? new HttpAdminApi('/api/admin', () => auth.token()) : null),
    [mode, auth, config.sessionUrl, role]
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
        onDemo={auth ? () => setMode('demo') : undefined}
      />
    );
  }

  return (
    <MailApp
      key={mode + nonce + (shared || '')}
      provider={session.provider}
      assistant={session.assistant}
      role={mode === 'demo' ? 'super_admin' : role}
      admin={admin}
      onSwitchMailbox={mode === 'gmail' ? (addr, own) => setShared(addr === own ? null : addr) : undefined}
      signOutLabel={mode === 'gmail' ? 'Sign out' : auth ? 'Exit demo' : 'Sign out'}
      onSignOut={signOut}
    />
  );
}
