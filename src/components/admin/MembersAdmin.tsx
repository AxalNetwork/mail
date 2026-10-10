import { useCallback, useEffect, useMemo, useState } from 'react';
import { DemoAdminApi, ROLE_LABEL, type AdminApi, type MailboxGrants, type Me, type Member, type Role } from '../../admin/api';
import { errorText, useToast } from '../Toast';

interface Props {
  /** Backend API; null outside a real deployment. */
  api: AdminApi | null;
  role: Role;
  demo: boolean;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function MembersAdmin({ api: real, role, demo }: Props) {
  const toast = useToast();
  const api = useMemo(() => real || (demo ? new DemoAdminApi() : null), [real, demo]);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [you, setYou] = useState<Me | null>(null);
  const [grants, setGrants] = useState<MailboxGrants | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [add, setAdd] = useState({ email: '', name: '', role: 'member' as 'member' | 'admin' });
  const [link, setLink] = useState({ google: '', member: '' });
  const [grant, setGrant] = useState({ mailbox: '', member: '' });
  const superAdmin = (you?.role || role) === 'super_admin';

  const load = useCallback(async () => {
    if (!api) return;
    setError(null);
    try {
      const r = await api.members();
      setMembers(r.members);
      setYou(r.you);
      if (r.you.role === 'super_admin') setGrants(await api.mailboxes());
    } catch (e) {
      setError(errorText(e));
    }
  }, [api]);
  useEffect(() => { load(); }, [load]);

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await fn();
      toast(done);
      await load();
      return true;
    } catch (e) {
      toast({ text: errorText(e), error: true });
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (!api) {
    return <section className="placeholder"><h1>Members & access</h1><span className="muted">Only administrators manage members.</span></section>;
  }

  const canEdit = (m: Member) => m.role !== 'super_admin' && m.email !== you?.memberEmail && (superAdmin || m.role === 'member');
  const valid = (e: string) => EMAIL_RE.test(e.trim());

  return (
    <section className="admin" aria-label="Administration · Members and access">
      <div className="page-inner" style={{ gap: 16 }}>
        <div className="page-title">
          <span className="mono-label">Administration</span>
          <h1>Members & access</h1>
          <span className="muted">
            Who can sign in to Axal VC Mail, which personal Google accounts sign in as a member, and who opens shared mailboxes.
            Every @{you?.memberEmail.split('@')[1] || 'axal.vc'} account can sign in unless suspended. Changes apply within five minutes.
          </span>
        </div>

        {error && <div className="card panel"><span className="tone-danger">{error}</span><button className="btn sm" onClick={load}>Try again</button></div>}

        <div className="card table">
          <div className="table-scroll">
            <div className="trow members head"><span>MEMBER</span><span>ROLE</span><span>STATUS</span><span>LINKED GOOGLE ACCOUNTS</span><span /></div>
            {!members && !error && <div className="trow members"><span className="muted">Loading…</span></div>}
            {members?.map(m => (
              <div key={m.email} className="trow members">
                <span className="user-cell"><b>{m.name || m.email.split('@')[0]}</b><span>{m.email}{m.email === you?.memberEmail ? ' · you' : ''}</span></span>
                <span>
                  {superAdmin && canEdit(m)
                    ? (
                      <select className="select sm" aria-label={'Role of ' + m.email} value={m.role} disabled={busy}
                        onChange={e => run(() => api.saveMember({ email: m.email, role: e.target.value as 'member' | 'admin' }), m.email + ' is now ' + ROLE_LABEL[e.target.value as Role].toLowerCase())}>
                        <option value="member">Member</option>
                        <option value="admin">Admin</option>
                      </select>
                    )
                    : <span className={'pill ' + (m.role === 'member' ? '' : 'accent')}>{ROLE_LABEL[m.role]}</span>}
                </span>
                <span><span className={'pill ' + (m.status === 'active' ? 'ok' : 'danger')}>{m.status === 'active' ? 'Active' : 'Suspended'}</span></span>
                <span className="row-wrap">
                  {m.linked.length === 0 && <span className="faint" style={{ fontSize: 12 }}>None</span>}
                  {m.linked.map(g => (
                    <span key={g} className="chip" style={{ fontSize: 12 }}>
                      {g}
                      {(canEdit(m) || m.email === you?.memberEmail) && (
                        <button aria-label={'Unlink ' + g} disabled={busy} onClick={() => run(() => api.unlink(g), g + ' unlinked')}>×</button>
                      )}
                    </span>
                  ))}
                </span>
                <span>
                  {canEdit(m) && (
                    <button className="btn sm" disabled={busy}
                      onClick={() => run(() => api.saveMember({ email: m.email, status: m.status === 'active' ? 'suspended' : 'active' }), m.email + (m.status === 'active' ? ' suspended' : ' restored'))}>
                      {m.status === 'active' ? 'Suspend' : 'Restore'}
                    </button>
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="admin-forms">
          <form className="card panel" onSubmit={async e => {
            e.preventDefault();
            const email = add.email.trim().toLowerCase();
            if (await run(() => api.saveMember({ email, name: add.name.trim(), ...(superAdmin ? { role: add.role } : {}) }), email + ' saved')) setAdd({ email: '', name: '', role: 'member' });
          }}>
            <span className="mono-label">Add or rename a member</span>
            <div className="profile-form">
              <label>Axal VC email<input className="input" type="email" placeholder="name@axal.vc" value={add.email} onChange={e => setAdd({ ...add, email: e.target.value })} /></label>
              <label>Display name<input className="input" placeholder="Julian Park" value={add.name} onChange={e => setAdd({ ...add, name: e.target.value })} /></label>
              {superAdmin && (
                <label>Role
                  <select className="select" value={add.role} onChange={e => setAdd({ ...add, role: e.target.value as 'member' | 'admin' })}>
                    <option value="member">Member</option>
                    <option value="admin">Admin</option>
                  </select>
                </label>
              )}
            </div>
            <div className="row-wrap"><button className="btn primary" disabled={busy || !valid(add.email)}>Save member</button></div>
          </form>

          <form className="card panel" onSubmit={async e => {
            e.preventDefault();
            const g = link.google.trim().toLowerCase();
            if (await run(() => api.link(g, link.member.trim().toLowerCase()), g + ' can now sign in with Continue with Google')) setLink({ google: '', member: '' });
          }}>
            <span className="mono-label">Link a personal Google account</span>
            <span className="muted" style={{ fontSize: 12 }}>The account signs in with <b>Continue with Google</b> and acts as the member.</span>
            <div className="profile-form">
              <label>Google account<input className="input" type="email" placeholder="name@gmail.com" value={link.google} onChange={e => setLink({ ...link, google: e.target.value })} /></label>
              <label>Member
                <input className="input" type="email" list="member-emails" placeholder="name@axal.vc" value={link.member} onChange={e => setLink({ ...link, member: e.target.value })} />
              </label>
            </div>
            <div className="row-wrap"><button className="btn primary" disabled={busy || !valid(link.google) || !valid(link.member)}>Link account</button></div>
          </form>
        </div>

        {superAdmin && grants && (
          <div className="card panel">
            <span className="mono-label">Shared mailboxes</span>
            {!grants.enabled && (
              <span className="muted" style={{ fontSize: 12.5 }}>
                Not set up yet. Shared mailboxes need a Google service account with domain-wide delegation, stored on the Worker as the
                <code> GOOGLE_SERVICE_ACCOUNT</code> secret. See the README, “Shared mailboxes”.
              </span>
            )}
            {grants.mailboxes.length === 0 && grants.enabled && <span className="faint" style={{ fontSize: 12.5 }}>No shared mailboxes yet.</span>}
            {grants.mailboxes.map(g => (
              <div key={g.mailbox} className="row-wrap" style={{ alignItems: 'center' }}>
                <b style={{ fontWeight: 600, minWidth: 180 }}>{g.mailbox}</b>
                {g.members.map(mem => (
                  <span key={mem} className="chip" style={{ fontSize: 12 }}>
                    {mem}
                    <button aria-label={'Remove ' + mem + ' from ' + g.mailbox} disabled={busy}
                      onClick={() => run(async () => setGrants(await api.revokeMailbox(g.mailbox, mem)), mem + ' removed from ' + g.mailbox)}>×</button>
                  </span>
                ))}
              </div>
            ))}
            {grants.enabled && (
              <form onSubmit={async e => {
                e.preventDefault();
                const mb = grant.mailbox.trim().toLowerCase();
                const mem = grant.member.trim().toLowerCase();
                if (await run(async () => setGrants(await api.grantMailbox(mb, mem)), mem + ' can now open ' + mb)) setGrant({ mailbox: '', member: '' });
              }}>
                <div className="profile-form">
                  <label>Mailbox<input className="input" type="email" placeholder="deals@axal.vc" value={grant.mailbox} onChange={e => setGrant({ ...grant, mailbox: e.target.value })} /></label>
                  <label>Member<input className="input" type="email" list="member-emails" placeholder="name@axal.vc" value={grant.member} onChange={e => setGrant({ ...grant, member: e.target.value })} /></label>
                </div>
                <div className="row-wrap" style={{ marginTop: 10 }}><button className="btn primary" disabled={busy || !valid(grant.mailbox) || !valid(grant.member)}>Give access</button></div>
              </form>
            )}
          </div>
        )}

        <datalist id="member-emails">{members?.map(m => <option key={m.email} value={m.email} />)}</datalist>
      </div>
    </section>
  );
}
