import { useState } from 'react';
import type { NewslettersApi, NlList } from '../../lib/newslettersApi';
import { errorText } from '../Toast';

interface Props {
  api: NewslettersApi;
  lists: NlList[];
  canManage: boolean;
  superAdmin: boolean;
  onLists: (l: NlList[]) => void;
  toast: (text: string, error?: boolean) => void;
}

/** Lists: public topics (offered on the website form) and private audiences such as LPs. */
export function AudiencesTab({ api, lists, canManage, superAdmin, onLists, toast }: Props) {
  const [n, setN] = useState({ name: '', description: '', public: false, requiresApproval: false });
  const run = (p: Promise<NlList[]>, done?: string) => p.then(l => { onLists(l); if (done) toast(done); }).catch(e => toast(errorText(e), true));

  return (
    <>
      <div className="card table table-scroll" aria-label="Lists">
        <div className="trow nl-lists head"><span>LIST</span><span>SUBSCRIBED</span><span>ON THE WEBSITE</span><span>APPROVAL</span><span>LAST SENT</span></div>
        {lists.map(l => (
          <div key={l.id} className="trow nl-lists">
            <span className="user-cell"><b>{l.name}</b><span>{l.description || l.key}</span></span>
            <span>{l.subscribed}</span>
            <span>
              {canManage
                ? <label className="check-row"><input type="checkbox" checked={l.public} onChange={e => run(api.updateList(l.id, { public: e.target.checked }))} /> {l.public ? 'Offered' : 'Private'}</label>
                : l.public ? 'Offered' : 'Private'}
            </span>
            <span>
              {canManage
                ? <label className="check-row"><input type="checkbox" checked={l.requiresApproval} disabled={l.requiresApproval && !superAdmin}
                    onChange={e => run(api.updateList(l.id, { requiresApproval: e.target.checked }))} /> {l.requiresApproval ? 'Required' : 'No'}</label>
                : l.requiresApproval ? 'Required' : 'No'}
            </span>
            <span className="muted">{l.lastSent ? new Date(l.lastSent).toLocaleDateString() : '—'}
              {canManage && <button className="btn ghost sm danger" style={{ marginLeft: 8 }} aria-label={'Delete ' + l.name}
                onClick={() => { if (window.confirm('Delete the list ' + l.name + '? Subscribers stay; they leave this list.')) run(api.removeList(l.id), 'List deleted.'); }}>✕</button>}
            </span>
          </div>
        ))}
      </div>
      {canManage && (
        <div className="card panel">
          <b>New list</b>
          <div className="row-wrap" style={{ alignItems: 'center' }}>
            <input className="input" placeholder="Name" value={n.name} maxLength={80} onChange={e => setN({ ...n, name: e.target.value })} />
            <input className="input" style={{ flex: 1 }} placeholder="Description" value={n.description} maxLength={200} onChange={e => setN({ ...n, description: e.target.value })} />
            <label className="check-row"><input type="checkbox" checked={n.public} onChange={e => setN({ ...n, public: e.target.checked })} /> Offer on the website</label>
            <label className="check-row"><input type="checkbox" checked={n.requiresApproval} onChange={e => setN({ ...n, requiresApproval: e.target.checked })} /> Needs approval</label>
            <button className="btn primary sm" disabled={n.name.trim().length < 2} onClick={() => run(api.createList(n), 'List created.').then(() => setN({ name: '', description: '', public: false, requiresApproval: false }))}>Create</button>
          </div>
          <span className="faint">Only a super admin removes “Needs approval” from a list.</span>
        </div>
      )}
    </>
  );
}
