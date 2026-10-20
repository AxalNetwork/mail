import type { FolderCounts } from '../providers/types';

export type View =
  | 'inbox' | 'starred' | 'snoozed' | 'sent' | 'drafts' | 'scheduled' | 'all' | 'search'
  | 'bulk' | 'admin' | 'members' | 'sequences'
  | 'shared' | 'internal' | 'contacts' | 'documents' | 'automations' | 'tasks' | 'analytics' | 'newsletters' | 'testing';

export const VIEW_TITLES: Record<View, string> = {
  inbox: 'Inbox', starred: 'Starred', snoozed: 'Snoozed', sent: 'Sent', drafts: 'Drafts', scheduled: 'Scheduled', all: 'All Mail',
  search: 'Search', bulk: 'Bulk email', admin: 'Administration', members: 'Members & access', sequences: 'Outreach sequences', shared: 'Shared Inboxes', internal: 'Internal',
  contacts: 'Contacts & Relationships', documents: 'Documents', automations: 'AI Automations', tasks: 'Tasks & Approvals', analytics: 'Analytics', newsletters: 'Newsletters', testing: 'Product testing'
};

interface Props {
  view: View;
  counts: FolderCounts & { internal?: number; tasks?: number; newsletters?: number };
  open: boolean;
  hide: Partial<Record<View, boolean>>;
  footer: string;
  onGo: (v: View) => void;
  onCompose: () => void;
}

export function Sidebar({ view, counts, open, hide, footer, onGo, onCompose }: Props) {
  const item = (id: View, count?: number) =>
    hide[id] ? null : (
      <button key={id} className={'nav-item' + (view === id ? ' on' : '')} aria-current={view === id ? 'page' : undefined} onClick={() => onGo(id)}>
        <span>{VIEW_TITLES[id]}</span>
        <span className="count">{count || ''}</span>
      </button>
    );
  return (
    <nav className={'sidebar' + (open ? ' open' : '')} aria-label="Mail folders">
      <button className="new-msg" onClick={onCompose}>✎ New message</button>
      <div className="nav-group">
        {item('inbox', counts.inbox)}
        {item('starred')}
        {item('snoozed', counts.snoozed)}
        {item('sent', counts.sent)}
        {item('drafts', counts.drafts)}
        {item('scheduled', counts.scheduled)}
        {item('all')}
        {item('bulk')}
      </div>
      <div className="nav-group">
        <span className="mono-label">Workspace</span>
        {item('shared')}
        {item('internal', counts.internal)}
        {item('contacts')}
        {item('documents')}
        {item('automations')}
        {item('newsletters', counts.newsletters)}
        {item('testing')}
        {item('tasks', counts.tasks)}
        {item('analytics')}
      </div>
      <div className="nav-group">
        <span className="mono-label">Organization</span>
        {item('admin')}
        {item('members')}
      </div>
      <div className="sidebar-foot">
        <a href="https://axal.vc" target="_blank" rel="noreferrer">Open axal.vc ↗</a>
        <span>{footer}</span>
      </div>
    </nav>
  );
}
