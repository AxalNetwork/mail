import { useEffect, useMemo, useState } from 'react';
import { config, gmailConfigured } from './config';
import { MailApp } from './MailApp';
import { ToastProvider, errorText } from './components/Toast';
import { DemoProvider } from './providers/demo/DemoProvider';
import { GmailProvider } from './providers/gmail/GmailProvider';
import { GoogleAuth } from './providers/gmail/auth';
import type { MailProvider } from './providers/types';
import { DemoAssistant } from './assistant/demo';
import { HttpAssistant } from './assistant/http';
import { OfflineAssistant } from './assistant/offline';
import type { Assistant } from './assistant/types';

type Mode = 'connect' | 'demo' | 'gmail';

interface Session {
  provider: MailProvider;
  assistant: Assistant;
}

function gmailSession(auth: GoogleAuth): Session {
  const provider = new GmailProvider(auth, config.orgDomain);
  const assistant = config.assistantUrl
    ? new HttpAssistant(config.assistantUrl, () => auth.token().catch(() => null))
    : new OfflineAssistant();
  return { provider, assistant };
}

export function App() {
  const auth = useMemo(() => (gmailConfigured ? new GoogleAuth(config.googleClientId) : null), []);
  const [mode, setMode] = useState<Mode>(() => (!auth ? 'demo' : auth.hasValidToken() ? 'gmail' : 'connect'));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!auth) return;
    auth.onSessionLost = () => {
      setError('Your Google session expired. Sign in again to continue; your drafts are saved in Gmail.');
      setMode('connect');
    };
    return () => { auth.onSessionLost = null; };
  }, [auth]);

  const session = useMemo<Session | null>(() => {
    if (mode === 'demo') return { provider: new DemoProvider(), assistant: new DemoAssistant() };
    if (mode === 'gmail' && auth) return gmailSession(auth);
    return null;
  }, [mode, auth, nonce]); // a new nonce starts a fresh session (e.g. restarting the demo)

  const connect = async () => {
    if (!auth) return;
    setBusy(true);
    setError(null);
    try {
      await auth.signIn();
      setMode('gmail');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const signOut = () => {
    session?.provider.signOut?.();
    setMode(auth ? 'connect' : 'demo');
    setNonce(n => n + 1);
  };

  return (
    <ToastProvider>
      {mode === 'connect' || !session ? (
        <ConnectScreen hint={auth?.loginHint || ''} busy={busy} error={error} onConnect={connect} onDemo={() => setMode('demo')} />
      ) : (
        <MailApp
          key={mode + nonce}
          provider={session.provider}
          assistant={session.assistant}
          signOutLabel={mode === 'demo' ? (auth ? 'Exit demo' : 'Restart demo') : 'Sign out of Gmail'}
          onSignOut={signOut}
        />
      )}
    </ToastProvider>
  );
}

function ConnectScreen(p: { hint: string; busy: boolean; error: string | null; onConnect: () => void; onDemo: () => void }) {
  return (
    <div className="connect">
      <div className="card connect-card">
        <div className="brand">
          <div className="brand-mark">A</div>
          <span className="brand-name">Axal VC</span>
          <span className="brand-tag">MAIL</span>
        </div>
        <h1>Connect your mailbox</h1>
        <p>Axal VC Mail works on top of your Google Workspace or Gmail account. Your mail stays in Gmail; this app reads and sends it through the Gmail API from your browser.</p>
        <ul>
          <li>Read, label, archive and send mail</li>
          <li>Use your Gmail send-as addresses and drafts</li>
          <li>Suggest recipients from your Google contacts</li>
          <li>Install the standard Axal VC signature</li>
        </ul>
        <button className="btn primary lg google-btn" disabled={p.busy} onClick={p.onConnect}>
          {p.busy ? 'Waiting for Google…' : p.hint ? 'Continue as ' + p.hint : 'Sign in with Google'}
        </button>
        {p.error && <div className="notice danger" role="alert">{p.error}</div>}
        <button className="link-btn" style={{ alignSelf: 'flex-start' }} onClick={p.onDemo}>Explore the demo with sample data instead</button>
      </div>
    </div>
  );
}
