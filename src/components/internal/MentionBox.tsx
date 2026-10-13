import { useMemo, useRef, useState } from 'react';
import type { Mentionable } from '../../providers/gmail/notes';

interface Props {
  value: string;
  onChange: (v: string) => void;
  members: Mentionable[];
  placeholder?: string;
  autoFocus?: boolean;
  onSubmit?: () => void;
  label: string;
}

/** The emails of members still @mentioned by name in the text. */
export function mentionedEmails(text: string, members: Mentionable[]): string[] {
  return members.filter(m => text.includes('@' + m.name)).map(m => m.email);
}

/** A textarea with @mention suggestions from the team's members. */
export function MentionBox({ value, onChange, members, placeholder, autoFocus, onSubmit, label }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const matches = useMemo(() => {
    if (query == null) return [];
    const q = query.toLowerCase();
    return members.filter(m => m.name.toLowerCase().includes(q) || m.email.includes(q)).slice(0, 6);
  }, [query, members]);

  const sync = (v: string, caret: number) => {
    const m = /(^|\s)@([\w.\- ]{0,30})$/.exec(v.slice(0, caret));
    setQuery(m && !/\s{2}/.test(m[2]) ? m[2] : null);
    setActive(0);
  };
  const pick = (m: Mentionable) => {
    const el = ref.current!;
    const caret = el.selectionStart;
    const before = value.slice(0, caret).replace(/@([\w.\- ]{0,30})$/, '@' + m.name + ' ');
    const next = before + value.slice(caret);
    onChange(next);
    setQuery(null);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(before.length, before.length); });
  };

  return (
    <div className="mention-box">
      <textarea ref={ref} className="textarea" rows={3} value={value} placeholder={placeholder} autoFocus={autoFocus} aria-label={label} maxLength={5000}
        onChange={e => { onChange(e.target.value); sync(e.target.value, e.target.selectionStart); }}
        onKeyDown={e => {
          if (matches.length && query != null) {
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => (a + 1) % matches.length); return; }
            if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => (a - 1 + matches.length) % matches.length); return; }
            if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(matches[active]); return; }
            if (e.key === 'Escape') { e.stopPropagation(); setQuery(null); return; }
          }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && onSubmit) { e.preventDefault(); onSubmit(); }
        }} />
      {query != null && matches.length > 0 && (
        <div className="popover mention-pop" role="listbox" aria-label="Mention a teammate">
          {matches.map((m, i) => (
            <button key={m.email} type="button" role="option" aria-selected={i === active} className={'pop-item' + (i === active ? ' sel' : '')}
              onMouseDown={e => { e.preventDefault(); pick(m); }}>
              <b style={{ fontWeight: 600 }}>{m.name}</b><span className="muted" style={{ fontSize: 11.5 }}>{m.email}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
