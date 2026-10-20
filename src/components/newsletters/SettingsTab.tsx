import { useEffect, useState } from 'react';
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

const when = (t: number | null) => (t ? new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');

/** Newsletter settings (N6): used by every newsletter and testing email. */
export function SettingsTab({ api, settings: s, you, superAdmin, onSaved, toast }: Props) {
  const [f, setF] = useState({
    postalAddress: s.postalAddress, disclaimer: s.disclaimer, fromName: s.fromName, defaultFrom: s.defaultFrom, dailyLimit: s.dailyLimit, perMinute: s.perMinute,
    doubleOptIn: s.doubleOptIn, origins: s.allowedOrigins.join('\n'), systemFrom: s.systemFrom
  });
  const [senders, setSenders] = useState<{ connected: boolean; error: string | null; addresses: { email: string; name: string; primary: boolean }[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [linkTest, setLinkTest] = useState<string>('');
  useEffect(() => { api.senders().then(setSenders).catch(e => setSenders({ connected: false, error: errorText(e), addresses: [] })); }, [api]);

  const save = (change: Partial<NlSettings>, done = 'Saved.') => {
    setBusy(true);
    api.saveSettings(change).then(x => { onSaved(x); toast(done); }).catch(e => toast(errorText(e), true)).finally(() => setBusy(false));
  };
  const snippet = `<div data-axal-newsletter></div>\n<script src="${s.embedScript}" defer></script>`;
  const chosen = f.defaultFrom || senders?.addresses.find(a => a.primary)?.email || '';

  return (
    <>
      {!s.linksReady && <div className="notice warn">The Worker needs the NEWSLETTER_SIGNING_KEY secret (or TOKEN_ENCRYPTION_KEY) for unsubscribe links. Nothing can be sent until it is set.</div>}

      <div className="nl-settings">
        <div className="card panel">
          <span className="mono-label">Sending address</span>
          <span className="faint">From the addresses you can send as.</span>
          {!senders && <div className="nl-skel"><span /><span /></div>}
          {senders && !senders.connected && <span className="muted">{senders.error} <span className="faint">Connect sending in Outreach sequences first.</span></span>}
          {senders?.addresses.map(a => (
            <label key={a.email} className="nl-radio">
              <input type="radio" name="from" checked={chosen === a.email} onChange={() => setF({ ...f, defaultFrom: a.email })} />
              <span><b>{a.email}</b><span className="faint">{a.primary ? 'Your own mailbox' : 'Send mail as · verified'}</span></span>
            </label>
          ))}
          <label className="nl-field"><span className="nl-field-head"><b>Name shown</b></span>
            <input className="input" maxLength={80} value={f.fromName} onChange={e => setF({ ...f, fromName: e.target.value })} />
          </label>
          <span className="faint">Recipients see “{f.fromName || 'Axal VC'}” with {chosen || 'your address'}.</span>
        </div>

        <div className="card panel">
          <span className="mono-label">Footer</span>
          <span className="faint">Every template’s footer reads these.</span>
          <label className="nl-field"><span className="nl-field-head"><b>Postal address</b></span>
            <textarea className="textarea" rows={2} maxLength={300} placeholder="Street, City, Postcode, Country" value={f.postalAddress} onChange={e => setF({ ...f, postalAddress: e.target.value })} />
          </label>
          <label className="nl-field"><span className="nl-field-head"><b>Disclaimer</b></span>
            <textarea className="textarea" rows={3} maxLength={1500} placeholder="Shown above every footer. Required for investors and LPs." value={f.disclaimer} onChange={e => setF({ ...f, disclaimer: e.target.value })} />
          </label>
        </div>

        <div className="card panel">
          <span className="mono-label">Sending limits</span>
          <span className="faint">Sends pause at the daily limit and resume the next day.</span>
          <div className="row-wrap">
            <label className="nl-field" style={{ flex: '1 1 140px' }}><span className="nl-field-head"><b>Daily send limit</b><em className="faint">per day</em></span>
              <input className="input" type="number" min={1} max={10000} value={f.dailyLimit} onChange={e => setF({ ...f, dailyLimit: Number(e.target.value) })} />
            </label>
            <label className="nl-field" style={{ flex: '1 1 140px' }}><span className="nl-field-head"><b>Throttle</b><em className="faint">per minute</em></span>
              <input className="input" type="number" min={1} max={60} value={f.perMinute} onChange={e => setF({ ...f, perMinute: Number(e.target.value) })} />
            </label>
          </div>
          <span className="muted">Today: {s.sentToday} of {s.dailyLimit} used</span>
          <div className="nl-progress"><span style={{ width: Math.min(100, (s.sentToday / Math.max(1, s.dailyLimit)) * 100) + '%' }} /></div>
        </div>

        <div className="card panel">
          <span className="mono-label">StudioOS link</span>
          <span className="faint">How Mail reads lists and programmes, and reports unsubscribes and bounces.</span>
          {s.link.configured
            ? <><span className="pill ok" style={{ alignSelf: 'flex-start' }}>Connected</span>
              <span className="muted">{s.link.readAt ? 'Last read ' + when(s.link.readAt) : 'Not read yet'}{s.link.lists != null ? ' · ' + s.link.lists + ' lists' : ''}{s.link.programmes != null ? ' · ' + s.link.programmes + ' programmes' : ''}</span></>
            : <><span className="pill" style={{ alignSelf: 'flex-start' }}>Not connected</span>
              <span className="muted">Not connected: an admin sets the link secret (MAIL_LINK_SECRET, the same value in both Workers). Until then, StudioOS lists and programmes can’t be read and nothing can be sent to them.</span></>}
          <div className="row-wrap" style={{ alignItems: 'center' }}>
            <button className="btn sm" disabled={!s.link.configured} onClick={() => { setLinkTest('…'); api.testLink().then(r => { setLinkTest(r.ok ? 'The link works.' : r.error || 'Failed.'); if (r.settings) onSaved(r.settings); }).catch(e => setLinkTest(errorText(e))); }}>Test the link</button>
            {linkTest && <span className={linkTest === 'The link works.' ? 'tone-ok' : 'muted'}>{linkTest}</span>}
          </div>
          <span className="faint">Read only. Mail never edits lists.</span>
        </div>
      </div>

      <div className="nl-footbar">
        <span className="faint">Used by every newsletter and testing email.{s.updatedBy ? ' Last changed by ' + s.updatedBy + ' · ' + when(s.updatedAt) + '.' : ''}</span>
        <span style={{ flex: 1 }} />
        <button className="btn primary sm" disabled={busy} onClick={() => save({ postalAddress: f.postalAddress, disclaimer: f.disclaimer, fromName: f.fromName, defaultFrom: f.defaultFrom, dailyLimit: f.dailyLimit, perMinute: f.perMinute }, 'Settings saved.')}>Save changes</button>
      </div>

      <div className="card panel">
        <span className="mono-label">Website signup and Mail’s own lists</span>
        <span className="muted">Until StudioOS keeps the website list, people who sign up on axal.vc land in Mail’s lists (Lists & subscribers).</span>
        <label className="check-row"><input type="checkbox" checked={f.doubleOptIn} onChange={e => setF({ ...f, doubleOptIn: e.target.checked })} /> Signups confirm by email first (double opt-in, recommended)</label>
        <span className="muted">
          {s.systemSender ? <>Confirmation and welcome emails are sent by <b>{s.systemSender}</b>{s.systemFrom ? ' as ' + s.systemFrom : ''}.</> : 'No sender for confirmation emails yet: signups wait until a super admin sets one.'}
        </span>
        {superAdmin && (
          <div className="row-wrap" style={{ alignItems: 'center' }}>
            <input className="input" placeholder={'From address (default ' + you + ')'} value={f.systemFrom} onChange={e => setF({ ...f, systemFrom: e.target.value })} style={{ flex: '1 1 240px' }} />
            <button className="btn sm" disabled={busy} onClick={() => save({ systemSender: you, systemFrom: f.systemFrom }, 'You now send confirmation emails.')}>Send them from my account</button>
            {s.systemSender && <button className="btn ghost sm danger" disabled={busy} onClick={() => save({ systemSender: null, systemFrom: '' }, 'Sender removed.')}>Remove</button>}
          </div>
        )}
        <span className="muted">Paste this where the form should appear on the website:</span>
        <pre className="nl-text" style={{ maxHeight: 'none' }}>{snippet}</pre>
        <div><button className="btn sm" onClick={() => navigator.clipboard.writeText(snippet).then(() => toast('Copied.')).catch(() => toast('Copy failed.', true))}>Copy</button></div>
        <label className="nl-field"><span className="nl-field-head"><b>Websites allowed to sign people up</b><em className="faint">one per line{superAdmin ? '' : ' · a super admin changes these'}</em></span>
          <textarea className="textarea" rows={2} disabled={!superAdmin} value={f.origins} onChange={e => setF({ ...f, origins: e.target.value })} />
        </label>
        <div><button className="btn sm" disabled={busy} onClick={() => save({ doubleOptIn: f.doubleOptIn, ...(superAdmin ? { allowedOrigins: f.origins.split(/\s+/).filter(Boolean) } : {}) })}>Save signup settings</button></div>
      </div>
    </>
  );
}
