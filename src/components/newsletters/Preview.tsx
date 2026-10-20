import { useState } from 'react';

type View = '600' | '375' | 'dark' | 'text';

/** The email as recipients see it: 600 px, 375 px, dark mode, and the plain-text version. */
export function Preview({ html, text, title = 'Preview' }: { html: string; text: string; title?: string }) {
  const [view, setView] = useState<View>('600');
  const doc = view === 'dark' ? html.replace('@media (prefers-color-scheme:dark){', '@media all{') : html;
  return (
    <div className="nl-preview card">
      <div className="row-wrap" style={{ alignItems: 'center', width: '100%' }}>
        <span className="mono-label">{title}</span>
        <span style={{ flex: 1 }} />
        <div className="seg" role="tablist" aria-label="Preview">
          {([['600', '600 px'], ['375', '375 px'], ['dark', 'Dark'], ['text', 'Plain text']] as [View, string][]).map(([k, l]) => (
            <button key={k} role="tab" aria-selected={view === k} className={view === k ? 'on' : ''} onClick={() => setView(k)}>{l}</button>
          ))}
        </div>
      </div>
      {view === 'text'
        ? <pre className="nl-text">{text}</pre>
        : <iframe title="Newsletter preview" className={'nl-frame' + (view === '375' ? ' mobile' : '')} sandbox="" srcDoc={doc} />}
    </div>
  );
}
