import { useEffect, useState } from 'react';
import type { Profile } from '../../types';
import type { MailProvider } from '../../providers/types';
import { EmailSignature } from '../EmailSignature';
import { errorText, useToast } from '../Toast';
import { missingFields, profileName, signatureHtml } from '../../lib/signature';

interface Props {
  provider: MailProvider;
  /** Called after the user's own details change, so the composer picks them up. */
  onProfileChanged: () => void;
}

const EDITABLE: { k: keyof Profile; label: string; placeholder: string }[] = [
  { k: 'first', label: 'First name', placeholder: 'Julian' },
  { k: 'last', label: 'Last name', placeholder: 'Park' },
  { k: 'title', label: 'Position', placeholder: 'Managing Partner' },
  { k: 'region', label: 'Region covered', placeholder: 'North America' },
  { k: 'whatsapp', label: 'WhatsApp', placeholder: '+1 212 555 0148' },
  { k: 'linkedin', label: 'LinkedIn', placeholder: 'linkedin.com/in/…' }
];

export function SignatureAdmin({ provider, onProfileChanged }: Props) {
  const toast = useToast();
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [selId, setSelId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Profile | null>(null);
  const [busy, setBusy] = useState(false);
  const demo = provider.capabilities.demo;

  useEffect(() => {
    provider.profiles().then(ps => { setProfiles(ps); setSelId(ps[0]?.id || null); }).catch(e => toast({ text: errorText(e), error: true }));
  }, [provider, toast]);

  const sel = profiles.find(p => p.id === selId) || profiles[0];
  const preview = draft || sel;

  const saveDetails = async () => {
    if (!draft || !provider.updateProfile) return;
    setBusy(true);
    try {
      await provider.updateProfile(draft);
      setProfiles(ps => ps.map(p => (p.id === draft.id ? draft : p)));
      setDraft(null);
      onProfileChanged();
      toast('Signature details saved');
    } catch (e) {
      toast({ text: errorText(e), error: true });
    } finally {
      setBusy(false);
    }
  };

  const install = async () => {
    if (!sel) return;
    setBusy(true);
    try {
      await provider.installSignature(signatureHtml(sel));
      toast('Signature installed in Gmail. It now also appears when you write from Gmail itself.');
    } catch (e) {
      toast({ text: 'Could not update the Gmail signature: ' + errorText(e), error: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="admin" aria-label="Administration · Email signature">
      <div className="page-inner" style={{ gap: 16 }}>
        <div className="page-title">
          <span className="mono-label">Administration</span>
          <h1>Email signature</h1>
          <span className="muted">One layout for everyone who uses Axal VC Mail. Details come from each person's Axal VC profile, and nobody can change the layout.</span>
        </div>

        {preview && (
          <div className="card sig-preview">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span className="mono-label">Preview</span>
              <b style={{ fontWeight: 600 }}>{profileName(preview)}</b>
              {provider.capabilities.installSignature && !draft && (
                <button className="btn soft sm" style={{ marginLeft: 'auto' }} disabled={busy} onClick={install}>Install in Gmail</button>
              )}
            </div>
            <div className="greeting">Best regards,</div>
            <EmailSignature profile={preview} />
            <small>
              Required: photo, first and last name, position, region covered, email, WhatsApp, LinkedIn. A missing line is left out of the signature until the profile is complete.
              {demo ? ' Photos show as initials in this demo.' : ' The photo comes from your Google account.'}
            </small>
          </div>
        )}

        {!demo && sel && provider.updateProfile && (
          <div className="card panel">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span className="mono-label">Your signature details</span>
              <span className="muted" style={{ fontSize: 12 }}>Filled from your Google profile. Changes are stored on this device.</span>
            </div>
            <div className="profile-form">
              {EDITABLE.map(f => (
                <label key={f.k}>
                  {f.label}
                  <input className="input" placeholder={f.placeholder} value={String((draft || sel)[f.k] ?? '')}
                    onChange={e => setDraft({ ...(draft || sel), [f.k]: e.target.value })} />
                </label>
              ))}
            </div>
            {draft && (
              <div className="row-wrap">
                <button className="btn primary" disabled={busy} onClick={saveDetails}>Save details</button>
                <button className="btn" onClick={() => setDraft(null)}>Cancel</button>
              </div>
            )}
          </div>
        )}

        <div className="card table">
          <div className="table-scroll">
            <div className="trow users head">
              <span>NAME</span><span>POSITION</span><span>REGION</span><span>WHATSAPP</span><span>LINKEDIN</span><span>PHOTO</span><span>STATUS</span><span />
            </div>
            {profiles.map(p => {
              const miss = missingFields(p);
              return (
                <div key={p.id} className={'trow users clickable' + (p.id === sel?.id ? ' on' : '')} onClick={() => { setSelId(p.id); setDraft(null); }}>
                  <span className="user-cell"><b>{profileName(p)}</b><span>{p.email}</span></span>
                  <span>{p.title || <span className="missing">Missing</span>}</span>
                  <span className={p.region ? '' : 'missing'}>{p.region || 'Missing'}</span>
                  <span className={'mono' + (p.whatsapp ? '' : ' missing')} style={{ fontSize: 12 }}>{p.whatsapp || 'Missing'}</span>
                  <span className={'ellipsis' + (p.linkedin ? '' : ' missing')} style={{ fontSize: 12 }}>{p.linkedin || 'Missing'}</span>
                  <span className={p.photo ? 'tone-accent' : 'missing'} style={p.photo ? { color: 'var(--ok)' } : undefined}>{p.photo ? 'On file' : 'Missing'}</span>
                  <span><span className={'pill ' + (miss.length ? 'warn' : 'ok')} style={{ border: 0, fontSize: 11.5, padding: '2px 9px' }}>{miss.length ? 'Missing ' + miss.join(', ') : 'Complete'}</span></span>
                  {miss.length > 0 && demo
                    ? <button className="btn sm" style={{ fontSize: 12 }} onClick={e => { e.stopPropagation(); toast('Asked ' + p.first + ' to complete their Axal VC profile'); }}>Request update</button>
                    : <span />}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
