import { useState } from 'react';
import type { ContactInput, OrgRecord } from '../../lib/contactsApi';

/** A blank record; an empty owner means "me" (the server fills in the member). */
export const emptyContact = (): ContactInput => ({
  name: '', emails: [], title: '', organizationId: null, website: '', linkedin: '', tags: [], notes: '', owner: '', visibility: 'team'
});

const splitList = (s: string) => s.split(/[,;\n]+/).map(x => x.trim()).filter(Boolean);

interface Props {
  initial: ContactInput;
  orgs: OrgRecord[];
  members: { email: string; name: string }[];
  /** The member may change owner and visibility (creator or owner; anyone on a new record). */
  canShare: boolean;
  saveLabel: string;
  /** Shown above the form, e.g. where a suggestion came from. */
  source?: React.ReactNode;
  onSave: (c: ContactInput) => Promise<void>;
  onCancel: () => void;
}

export function ContactForm({ initial, orgs, members, canShare, saveLabel, source, onSave, onCancel }: Props) {
  const [c, setC] = useState(initial);
  const [emails, setEmails] = useState(initial.emails.join(', '));
  const [tagText, setTagText] = useState(initial.tags.join(', '));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = <K extends keyof ContactInput>(k: K, v: ContactInput[K]) => setC(x => ({ ...x, [k]: v }));
  const owners = members.some(m => m.email === c.owner) || !c.owner ? members : [...members, { email: c.owner, name: c.owner }];

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      await onSave({ ...c, name: c.name.trim(), emails: splitList(emails).map(x => x.toLowerCase()), tags: splitList(tagText) });
    } catch (x) {
      setErr(x instanceof Error ? x.message : String(x));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card panel" onSubmit={save} aria-label="Contact details">
      {source}
      <div className="profile-form">
        <label>Name<input className="input" required maxLength={200} value={c.name} onChange={e => set('name', e.target.value)} /></label>
        <label>Email addresses (comma-separated)<input className="input" value={emails} onChange={e => setEmails(e.target.value)} placeholder="name@company.com, name@gmail.com" /></label>
        <label>Role or title<input className="input" maxLength={200} value={c.title} onChange={e => set('title', e.target.value)} /></label>
        <label>Organization
          <select className="input" value={c.organizationId ?? ''} onChange={e => set('organizationId', e.target.value ? Number(e.target.value) : null)}>
            <option value="">None</option>
            {orgs.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </label>
        <label>Website<input className="input" maxLength={300} value={c.website} onChange={e => set('website', e.target.value)} placeholder="Only if you know it" /></label>
        <label>LinkedIn URL<input className="input" maxLength={300} value={c.linkedin} onChange={e => set('linkedin', e.target.value)} placeholder="linkedin.com/in/…" /></label>
        <label>Tags (comma-separated)<input className="input" value={tagText} onChange={e => setTagText(e.target.value)} placeholder="Founder, AI, Fund II" /></label>
        <label>Relationship owner
          <select className="input" value={c.owner} disabled={!canShare} onChange={e => set('owner', e.target.value)}>
            {!c.owner && <option value="">Me</option>}
            {owners.map(m => <option key={m.email} value={m.email}>{m.name || m.email}</option>)}
          </select>
        </label>
        <label>Who can see it
          <select className="input" value={c.visibility} disabled={!canShare} onChange={e => set('visibility', e.target.value as ContactInput['visibility'])}>
            <option value="team">The whole team</option>
            <option value="private">Only me and the owner</option>
          </select>
        </label>
      </div>
      <label className="seq-field">Notes{c.visibility === 'team' ? ' (the team can read these)' : ' (private)'}
        <textarea className="textarea" rows={4} maxLength={10000} value={c.notes} onChange={e => set('notes', e.target.value)} />
      </label>
      {!canShare && <span className="faint" style={{ fontSize: 12 }}>Only the creator or the relationship owner can change the owner or who sees this record.</span>}
      {err && <span className="tone-danger" role="alert" style={{ fontSize: 12.5 }}>{err}</span>}
      <div className="row-wrap">
        <button className="btn primary sm" type="submit" disabled={busy || !c.name.trim()}>{busy ? 'Saving…' : saveLabel}</button>
        <button className="btn ghost sm" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
