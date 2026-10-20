import { useState } from 'react';
import type { NewslettersApi, NlSettings } from '../../lib/newslettersApi';
import { errorText } from '../Toast';

interface Props {
  api: NewslettersApi;
  settings: NlSettings;
  you: string;
  superAdmin: boolean;
  onSaved: (s: NlSettings) => void;
  toast: (text: string, error?: boolean) => void;
}

export function SettingsTab({ api, settings: s, you, superAdmin, onSaved, toast }: Props) {
  const [f, setF] = useState({ postalAddress: s.postalAddress, disclaimer: s.disclaimer, fromName: s.fromName, doubleOptIn: s.doubleOptIn, batchSize: s.batchSize, origins: s.allowedOrigins.join('\n'), systemFrom: s.systemFrom });
  const [busy, setBusy] = useState(false);
  const save = (change: Partial<NlSettings>, done = 'Settings saved.') => {
    setBusy(true);
    api.saveSettings(change).then(x => { onSaved(x); toast(done); }).catch(e => toast(errorText(e), true)).finally(() => setBusy(false));
  };
  const snippet = `<div data-axal-newsletter></div>\n<script src="${s.embedScript}" defer></script>`;

  return (
    <>
      {!s.linksReady && <div className="notice warn">The Worker needs the NEWSLETTER_SIGNING_KEY secret (or TOKEN_ENCRYPTION_KEY) for unsubscribe and confirmation links. Nothing can be sent until it is set.</div>}
      <div className="card panel">
        <span className="mono-label">Every newsletter’s footer</span>
        <label className="nl-field"><span>Postal address (required by law in every newsletter)</span>
          <textarea className="textarea" rows={2} maxLength={300} value={f.postalAddress} onChange={e => setF({ ...f, postalAddress: e.target.value })} />
        </label>
        <label className="nl-field"><span>Disclaimer (required for investor and LP lists)</span>
          <textarea className="textarea" rows={3} maxLength={1500} value={f.disclaimer} onChange={e => setF({ ...f, disclaimer: e.target.value })} />
        </label>
        <label className="nl-field"><span>Name shown as the sender</span>
          <input className="input" maxLength={80} value={f.fromName} onChange={e => setF({ ...f, fromName: e.target.value })} />
        </label>
        <label className="check-row"><input type="checkbox" checked={f.doubleOptIn} onChange={e => setF({ ...f, doubleOptIn: e.target.checked })} /> Website signups confirm by email first (double opt-in, recommended)</label>
        <label className="nl-field"><span>Emails per run (the Worker runs every 10 minutes; Gmail limits apply)</span>
          <input className="input" type="number" min={5} max={200} value={f.batchSize} onChange={e => setF({ ...f, batchSize: Number(e.target.value) })} style={{ width: 120 }} />
        </label>
        <div><button className="btn primary sm" disabled={busy} onClick={() => save({ postalAddress: f.postalAddress, disclaimer: f.disclaimer, fromName: f.fromName, doubleOptIn: f.doubleOptIn, batchSize: f.batchSize })}>Save</button></div>
      </div>

      <div className="card panel">
        <span className="mono-label">Confirmation and welcome emails</span>
        <span className="muted">
          {s.systemSender ? <>Sent by <b>{s.systemSender}</b>{s.systemFrom ? ' as ' + s.systemFrom : ''}.</> : 'No sender yet: website signups wait until a super admin sets one.'}
          {' '}They go out with that person’s “Connect sending” grant (Outreach sequences → Connect sending).
        </span>
        {superAdmin && (
          <div className="row-wrap" style={{ alignItems: 'center' }}>
            <input className="input" placeholder={'From address (default ' + you + ')'} value={f.systemFrom} onChange={e => setF({ ...f, systemFrom: e.target.value })} style={{ flex: '1 1 240px' }} />
            <button className="btn sm" disabled={busy} onClick={() => save({ systemSender: you, systemFrom: f.systemFrom }, 'You now send confirmation emails.')}>Send them from my account</button>
            {s.systemSender && <button className="btn ghost sm danger" disabled={busy} onClick={() => save({ systemSender: null, systemFrom: '' }, 'Sender removed.')}>Remove</button>}
          </div>
        )}
      </div>

      <div className="card panel">
        <span className="mono-label">Website signup (axal.vc)</span>
        <span className="muted">Paste this where the form should appear on the website:</span>
        <pre className="nl-text" style={{ maxHeight: 'none' }}>{snippet}</pre>
        <div className="row-wrap">
          <button className="btn sm" onClick={() => navigator.clipboard.writeText(snippet).then(() => toast('Copied.')).catch(() => toast('Copy failed.', true))}>Copy</button>
        </div>
        <span className="faint">Or post a plain HTML form (fields email, consent, topics) to {s.signupEndpoint}</span>
        <label className="nl-field"><span>Websites allowed to sign people up (one per line){superAdmin ? '' : ' · a super admin changes these'}</span>
          <textarea className="textarea" rows={3} disabled={!superAdmin} value={f.origins} onChange={e => setF({ ...f, origins: e.target.value })} />
        </label>
        {superAdmin && <div><button className="btn sm" disabled={busy} onClick={() => save({ allowedOrigins: f.origins.split(/\s+/).filter(Boolean) })}>Save websites</button></div>}
      </div>
    </>
  );
}
