import type { Category, ThreadSummary } from '../types';

interface Props {
  title: string;
  meta: string;
  categories: Category[] | null;
  category: string;
  threads: ThreadSummary[];
  selectedId: string | null;
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  onCategory: (id: string) => void;
  onOpen: (t: ThreadSummary) => void;
  onStar: (t: ThreadSummary) => void;
  onMore: () => void;
  onRefresh: () => void;
}

export function ThreadList(p: Props) {
  return (
    <section className="list-pane" aria-label={p.title}>
      <div className="list-head">
        <div className="list-head-row">
          <h1>{p.title}</h1>
          <button className="btn ghost sm" title="Refresh" aria-label="Refresh" onClick={p.onRefresh}>↻</button>
        </div>
        <span className="muted">{p.meta}</span>
      </div>
      {p.categories ? (
        <div className="tabs" role="tablist">
          {p.categories.map(c => (
            <button key={c.id} role="tab" aria-selected={p.category === c.id} className={'tab' + (p.category === c.id ? ' on' : '')}
              onClick={() => p.onCategory(c.id)}>{c.label}</button>
          ))}
        </div>
      ) : <div className="tabs-spacer" />}
      <div className="rows">
        {p.error && <div className="center-msg"><span className="tone-danger">{p.error}</span><button className="btn sm" onClick={p.onRefresh}>Try again</button></div>}
        {!p.error && !p.threads.length && (p.loading ? <div className="center-msg"><div className="spinner" /></div> : <div className="center-msg">Nothing here yet.</div>)}
        {p.threads.map(t => (
          <div key={t.id} role="button" tabIndex={0}
            className={'row' + (t.unread ? ' unread' : '') + (p.selectedId === t.id ? ' sel' : '')}
            onClick={() => p.onOpen(t)}
            onKeyDown={e => { if (e.key === 'Enter') p.onOpen(t); }}>
            <div className="dot-col">{t.unread && <div className="unread-dot" aria-label="Unread" />}</div>
            <div className="row-main">
              <div className="row-top">
                <span className="row-from ellipsis">{t.from} {t.org && <span className="org">· {t.org}</span>}</span>
                <span className="row-time">{t.time}</span>
              </div>
              <div className="row-subject ellipsis">{t.subject}</div>
              <div className="row-snippet ellipsis">{t.snippet}</div>
              <div className="row-tags">
                {t.labels.map(l => <span key={l} className="pill">{l}</span>)}
                {t.sensitive && <span className="pill danger">Sensitive</span>}
                {t.attachCount > 0 && <span className="attach">⎘ {t.attachCount}</span>}
                {t.followup && <span className="pill warn">{t.followup}</span>}
                {!t.draftId && (
                  <button className={'star' + (t.starred ? ' on' : '')} aria-label={t.starred ? 'Unstar' : 'Star'} aria-pressed={t.starred}
                    onClick={e => { e.stopPropagation(); p.onStar(t); }}>★</button>
                )}
              </div>
            </div>
          </div>
        ))}
        {p.hasMore && (
          <div className="load-more">
            <button className="btn sm" disabled={p.loading} onClick={p.onMore}>{p.loading ? 'Loading…' : 'Load more'}</button>
          </div>
        )}
      </div>
    </section>
  );
}
