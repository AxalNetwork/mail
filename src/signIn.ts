import type { AppConfig } from './config';
import { GoogleSignInError, type GoogleAuth, type SignInOptions } from './providers/gmail/auth';
import { LoginError, type SignedIn } from './components/LoginScreen';
import { PROFILES } from './providers/demo/data';
import { profileName } from './lib/signature';
import type { Me, Role } from './admin/api';

const USERINFO = 'https://www.googleapis.com/oauth2/v3/userinfo';

function nameFromEmail(email: string): string {
  return email.split('@')[0].split(/[._-]/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
}

interface SessionResponse {
  user?: Me;
  error?: string;
  code?: string;
}

/**
 * The member behind a token, for a session restored without the login screen:
 * the member, 'denied' when the backend refuses the account (not a member,
 * suspended, token not ours), or null when the backend can't be reached.
 */
export async function fetchMe(sessionUrl: string, token: string): Promise<Me | 'denied' | null> {
  try {
    const res = await fetch(sessionUrl, { headers: { Authorization: 'Bearer ' + token } });
    if (res.status === 401 || res.status === 403) return 'denied';
    return res.ok ? ((await res.json()) as SessionResponse).user || null : null;
  } catch {
    return null;
  }
}

/**
 * Real sign-in: Google's consent popup, then the backend confirms the account
 * belongs to an active Axal VC member (directly, or as a linked personal account).
 */
export async function gmailSignIn(auth: GoogleAuth, config: AppConfig, o: SignInOptions, checking: () => void): Promise<SignedIn> {
  let token: string;
  try {
    token = await auth.signIn(o);
  } catch (e) {
    if (e instanceof GoogleSignInError && e.type === 'popup_closed') throw new LoginError('Sign-in was cancelled', 'The Google window closed before you finished. Try again.');
    if (e instanceof GoogleSignInError && e.type === 'popup_failed_to_open') throw new LoginError('Pop-up blocked', e.message);
    throw new LoginError("Couldn't sign you in", e instanceof Error ? e.message : String(e));
  }
  checking();

  if (config.sessionUrl) {
    let res: Response;
    try {
      res = await fetch(config.sessionUrl, { headers: { Authorization: 'Bearer ' + token } });
    } catch {
      auth.signOut();
      throw new LoginError("Couldn't reach Axal VC Mail", 'Check your connection and try again.');
    }
    const j = (await res.json().catch(() => ({}))) as SessionResponse;
    if (!res.ok || !j.user) {
      auth.signOut(); // revoke, so the next attempt can pick a different account
      if (j.code === 'not_linked') throw new LoginError("This Google account isn't linked to Axal VC", j.error || '');
      if (j.code === 'suspended') throw new LoginError('Account suspended', j.error || '');
      throw new LoginError("Couldn't sign you in", j.error || 'The server rejected the sign-in (' + res.status + ').');
    }
    // The Google account decides whose mail opens, so it must be the address that was typed.
    if (o.hint && j.user.email.toLowerCase() !== o.hint.toLowerCase()) {
      auth.signOut();
      throw new LoginError('Different Google account',
        'You entered ' + o.hint + ' but Google signed in ' + j.user.email + '. Choose ' + o.hint + ' in the Google window, or sign out of the other account in your browser first.');
    }
    auth.loginHint = j.user.email;
    return { name: j.user.name || nameFromEmail(j.user.memberEmail), email: j.user.email, role: j.user.role };
  }

  // Frontend running without the backend: Google's profile is all there is.
  const info = (await (await fetch(USERINFO, { headers: { Authorization: 'Bearer ' + token } })).json()) as { email: string; name?: string };
  auth.loginHint = info.email;
  return { name: info.name || nameFromEmail(info.email), email: info.email };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Demo deployment: the same screens, nothing contacted. */
export async function demoSignIn(o: SignInOptions, checking: () => void): Promise<SignedIn> {
  await sleep(1100);
  checking();
  await sleep(900);
  const email = o.hint || PROFILES[0].email;
  const p = PROFILES.find(x => x.email === email);
  return { name: p ? profileName(p) : nameFromEmail(email), email, role: 'super_admin' satisfies Role };
}
