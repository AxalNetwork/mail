import type { Block, Item } from '../../lib/newsletter/types';

/** The form for one block. Every field is plain text with the small markup the renderer supports. */

interface Props {
  block: Block;
  disabled: boolean;
  onChange: (b: Block) => void;
  /** Ask the assistant to rewrite a long text field (shorten, or draft from notes). */
  onAssist?: (mode: 'draft' | 'shorten', text: string, apply: (t: string) => void) => void;
}

export function BlockForm({ block: b, disabled, onChange, onAssist }: Props) {
  const set = (patch: Record<string, unknown>) => onChange({ ...b, ...patch } as Block);
  const line = (key: string, label: string, value: string, max: number, placeholder = '') => (
    <label className="nl-field" key={key}>
      <span>{label}</span>
      <input className="input" value={value} maxLength={max} disabled={disabled} placeholder={placeholder} onChange={e => set({ [key]: e.target.value })} />
    </label>
  );
  const area = (key: string, label: string, value: string, max: number, rows = 4) => (
    <label className="nl-field" key={key}>
      <span>{label} <em className="faint">{value.length}/{max}</em></span>
      <textarea className="textarea" rows={rows} value={value} maxLength={max} disabled={disabled} onChange={e => set({ [key]: e.target.value })} />
      {onAssist && !disabled && (
        <span className="row-wrap">
          <button type="button" className="link-btn" onClick={() => onAssist('draft', value, t => set({ [key]: t }))}>Write from these notes</button>
          <button type="button" className="link-btn" onClick={() => onAssist('shorten', value, t => set({ [key]: t }))}>Shorten</button>
        </span>
      )}
    </label>
  );
  const items = (list: Item[], withMeta: string) => (
    <div className="nl-items">
      {list.map((it, i) => {
        const put = (patch: Partial<Item>) => set({ items: list.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
        return (
          <div className="nl-item" key={i}>
            <input className="input" aria-label="Title" placeholder="Title" value={it.title} maxLength={200} disabled={disabled} onChange={e => put({ title: e.target.value })} />
            <input className="input" aria-label="Text" placeholder="Text" value={it.text} maxLength={600} disabled={disabled} onChange={e => put({ text: e.target.value })} />
            <input className="input" aria-label={withMeta} placeholder={withMeta} value={it.meta} maxLength={60} disabled={disabled} onChange={e => put({ meta: e.target.value })} />
            <input className="input" aria-label="Link" placeholder="https://" value={it.url} maxLength={600} disabled={disabled} onChange={e => put({ url: e.target.value })} />
            {!disabled && <button type="button" className="btn ghost sm" aria-label="Remove item" onClick={() => set({ items: list.filter((_, j) => j !== i) })}>✕</button>}
          </div>
        );
      })}
      {!disabled && list.length < 12 && <button type="button" className="btn ghost sm" onClick={() => set({ items: [...list, { title: '', text: '', meta: '', url: '' }] })}>+ Add item</button>}
    </div>
  );

  switch (b.type) {
    case 'hero': return <>{line('kicker', 'Kicker', b.kicker, 80)}{line('title', 'Title', b.title, 160)}{area('text', 'Text', b.text, 1200, 3)}</>;
    case 'note': return <>{line('label', 'Label', b.label, 80)}{area('text', 'Note', b.text, 12000, 6)}{line('name', 'Signed by', b.name, 80)}{line('title', 'Their title', b.title, 100)}</>;
    case 'essay': return <>{line('label', 'Label', b.label, 80)}{line('title', 'Headline', b.title, 160)}{area('text', 'Summary', b.text, 400, 2)}{line('meta', 'Meta', b.meta, 60, 'ESSAY · 8 MIN READ')}{line('url', 'Link', b.url, 600, 'https://')}</>;
    case 'items': return <>{line('label', 'Label', b.label, 80)}{items(b.items, 'Meta')}{line('footerLabel', 'Footer link label', b.footerLabel, 60)}{line('footerUrl', 'Footer link', b.footerUrl, 600, 'https://')}</>;
    case 'events': return <>{line('label', 'Label', b.label, 80)}{items(b.items, 'Date, e.g. OCT 24')}</>;
    case 'text': return <>{line('label', 'Label', b.label, 80)}{line('heading', 'Heading', b.heading, 160)}{area('text', 'Text', b.text, 20000, 8)}</>;
    case 'quote': return <>{area('text', 'Quote', b.text, 400, 2)}{line('attribution', 'Attribution', b.attribution, 120)}</>;
    case 'image': return <>{line('src', 'Image address', b.src, 1000, 'https://')}{line('alt', 'Alt text (required)', b.alt, 200)}{line('url', 'Link', b.url, 600, 'https://')}{line('caption', 'Caption', b.caption, 200)}</>;
    case 'button': return <>{line('label', 'Button', b.label, 60)}{line('url', 'Link', b.url, 600, 'https://')}{line('secondaryLabel', 'Second link label', b.secondaryLabel, 60)}{line('secondaryUrl', 'Second link', b.secondaryUrl, 600, 'https://')}</>;
    case 'callout': return <>{line('value', 'Figure', b.value, 24)}{line('text', 'What it means', b.text, 200)}{line('source', 'Source', b.source, 120)}</>;
    case 'tags': return (
      <label className="nl-field"><span>Tags (comma-separated, up to 6)</span>
        <input className="input" disabled={disabled} value={b.tags.join(', ')} onChange={e => set({ tags: e.target.value.split(',').map(t => t.trimStart()).slice(0, 6) })} />
      </label>
    );
    case 'divider': return <span className="faint">A thin line between sections.</span>;
  }
}
