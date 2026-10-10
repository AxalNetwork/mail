import { useEffect, useRef, useState } from 'react';
import type { SignInOptions } from '../providers/gmail/auth';

export type LoginReason = 'signed-out' | 'expired' | 'lost';

export interface SignedIn {
  name: string;
  email: string;
}

/** A sign-in failure with the short title the design shows above the message. */
export class LoginError extends Error {
  constructor(readonly title: string, message: string) {
    super(message);
  }
}

interface Props {
  /** Domain for the "Axal VC email" field, e.g. axal.vc. */
  orgDomain: string;
  reason: LoginReason;
  /** Sign-in is simulated (demo deployment); shows the demo banner. */
  simulated: boolean;
  /** Runs the sign-in. Call `checking()` once Google has returned, before the account check. */
  signIn: (o: SignInOptions, checking: () => void) => Promise<SignedIn>;
  onDone: () => void;
  /** Offered as a link when real sign-in is available. */
  onDemo?: () => void;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DONE_MS = 1400;

const REASON_TEXT: Record<LoginReason, string> = {
  'signed-out': '',
  expired: 'Your session ended after 12 hours. Sign in again to continue where you left off.',
  lost: 'Your Google session ended. Sign in again to continue; your drafts are saved in Gmail.'
};

export function LoginScreen({ orgDomain, reason, simulated, signIn, onDone, onDemo }: Props) {
  const [step, setStep] = useState<'start' | 'handoff' | 'done'>('start');
  const [phase, setPhase] = useState<'out' | 'back'>('out');
  const [via, setVia] = useState<'email' | 'google'>('google');
  const [email, setEmail] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState<{ title: string; text: string } | null>(null);
  const [who, setWho] = useState<SignedIn | null>(null);
  const attempt = useRef(0);
  const doneTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const domain = orgDomain || 'axal.vc';

  useEffect(() => () => clearTimeout(doneTimer.current), []);

  const run = async (how: 'email' | 'google', hint?: string) => {
    const id = ++attempt.current;
    setVia(how);
    setPhase('out');
    setError(null);
    setFieldError(null);
    setStep('handoff');
    try {
      const signedIn = await signIn(how === 'google' ? { selectAccount: true } : { hint }, () => {
        if (attempt.current === id) setPhase('back');
      });
      if (attempt.current !== id) return; // cancelled
      setWho(signedIn);
      setStep('done');
      doneTimer.current = setTimeout(onDone, DONE_MS);
    } catch (e) {
      if (attempt.current !== id) return;
      setStep('start');
      setError(e instanceof LoginError ? { title: e.title, text: e.message } : { title: "Couldn't sign you in", text: e instanceof Error ? e.message : String(e) });
    }
  };

  const submitEmail = () => {
    const e = email.trim().toLowerCase();
    if (!e) return setFieldError('Enter your Axal VC email.');
    if (!EMAIL_RE.test(e)) return setFieldError("That doesn't look like an email address.");
    if (!e.endsWith('@' + domain)) return setFieldError(`Use your @${domain} address here. For a personal Gmail linked to your profile, use Continue with Google.`);
    setEmail(e);
    run('email', e);
  };

  const cancel = () => {
    attempt.current++;
    setStep('start');
    setError(null);
  };

  const out = phase === 'out';

  return (
    <div className="login" data-screen-label="Login">
      {simulated && (
        <div className="banner">
          <span className="mono-label">Demo mode</span>
          <span>Sign-in is simulated. No Google account is contacted.</span>
        </div>
      )}
      <main className="login-main">
        <div className="login-col">
          <div className="login-brand">
            <img src="/login/axal-logo.png" alt="Axal VC logo" width={34} height={32} />
            <span className="name">Axal VC</span>
            <span className="brand-tag">MAIL</span>
          </div>

          <div className="login-card">
            {step === 'start' && (
              <>
                <div className="login-head">
                  <h1>Sign in</h1>
                  <span className="muted">Use your Axal VC email, or a Google account linked to your Axal VC profile. What you can see in Mail follows your role and permissions.</span>
                </div>
                {REASON_TEXT[reason] && !error && <div className="login-note">{REASON_TEXT[reason]}</div>}
                {error && (
                  <div className="login-error" role="alert">
                    <b>{error.title}</b>
                    <span>{error.text}</span>
                  </div>
                )}
                <form className="login-form" noValidate onSubmit={e => { e.preventDefault(); submitEmail(); }}>
                  <label>
                    <span className="mono-key">AXAL VC EMAIL</span>
                    <input type="email" className={fieldError ? 'bad' : ''} value={email} placeholder={'name@' + domain} autoComplete="username"
                      aria-invalid={!!fieldError} aria-describedby={fieldError ? 'login-field-error' : undefined}
                      onChange={e => { setEmail(e.target.value); setFieldError(null); }} />
                  </label>
                  {fieldError && <span id="login-field-error" className="field-error">{fieldError}</span>}
                  <button type="submit" className="btn primary login-btn">Continue</button>
                </form>
                <div className="login-or"><span />or<span /></div>
                <button className="btn login-btn google" onClick={() => run('google')}>
                  <span className="g" aria-hidden="true">G</span>
                  Continue with Google
                </button>
                <span className="login-help">A regular Gmail account works if it's linked to your Axal VC profile. Two-step verification is handled by Google.</span>
                {onDemo && <button className="link-btn login-demo" onClick={onDemo}>Explore the demo with sample data</button>}
              </>
            )}

            {step === 'handoff' && (
              <div className="login-state" aria-live="polite">
                <div className="login-spinner" />
                <b>{out ? (via === 'email' ? 'Opening sign-in for ' + email : 'Opening Google sign-in') : 'Checking your Axal VC account'}</b>
                <span className="mono">{out ? 'accounts.google.com' : typeof window !== 'undefined' ? window.location.host : 'mail.axal.vc'}</span>
                <button className="link-btn muted" onClick={cancel}>Cancel</button>
              </div>
            )}

            {step === 'done' && who && (
              <div className="login-state" aria-live="polite">
                <div className="login-check">✓</div>
                <b className="big">Signed in as {who.name}</b>
                <span className="mono">Mailbox · {who.email}</span>
                <span className="muted">Opening your mailboxes…</span>
                <button className="link-btn strong" onClick={() => { clearTimeout(doneTimer.current); onDone(); }}>Continue to Mail →</button>
              </div>
            )}
          </div>

          <nav className="login-links" aria-label="Axal VC">
            <a href="https://axal.vc" target="_blank" rel="noreferrer">axal.vc</a>
            <a href="https://axal.vc/help" target="_blank" rel="noreferrer">Help</a>
            <a href="https://axal.vc/privacy" target="_blank" rel="noreferrer">Privacy</a>
          </nav>
        </div>
      </main>
    </div>
  );
}
