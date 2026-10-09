import type { AiInsight } from '../types';

interface Props {
  insight: AiInsight | null;
  loading: boolean;
  emptyText: string;
  onClose: () => void;
  onDraft: () => void;
  onFollowUp: () => void;
}

export function AssistantPanel({ insight, loading, emptyText, onClose, onDraft, onFollowUp }: Props) {
  return (
    <aside className="assistant" aria-label="AI assistant">
      <div className="assistant-head">
        <span className="spark">✦</span><b>Assistant</b>
        <small>Uses only what you can access</small>
        <button className="close-x" aria-label="Close assistant" onClick={onClose}>×</button>
      </div>
      {loading && <div className="assistant-empty"><div className="spinner" /></div>}
      {!loading && !insight && <div className="assistant-empty">{emptyText}</div>}
      {!loading && insight && (
        <div className="assistant-body">
          <div className="ai-section">
            <span className="mono-label">Summary</span>
            <p>{insight.summary}</p>
          </div>
          {insight.points.length > 0 && (
            <div className="ai-section">
              <span className="mono-label">Extracted</span>
              {insight.points.map((pt, i) => (
                <div key={i} className="ai-point">
                  <span className={'kind tone-' + pt.tone}>{pt.kind}</span>
                  <span style={{ lineHeight: 1.45 }}>{pt.text}</span>
                  <span className="src">Source: {pt.src}</span>
                </div>
              ))}
            </div>
          )}
          <div className="row-wrap">
            {insight.draft && <button className="btn primary sm" onClick={onDraft}>✦ Draft a reply</button>}
            <button className="btn sm" onClick={onFollowUp}>Create follow-up</button>
          </div>
        </div>
      )}
    </aside>
  );
}
