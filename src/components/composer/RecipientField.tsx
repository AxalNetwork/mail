import { useEffect, useRef, useState } from 'react';
import type { Contact, Person } from '../../types';
import { isInternal, parsePerson } from '../../lib/compose';
import { initials } from '../../lib/format';

interface Props {
  label: string;
  people: Person[];
  orgDomain: string;
  /** Addresses already used in any field (hidden from suggestions). */
  used: Set<string>;
  autoFocus?: boolean;
  search: (q: string) => Promise<Contact[]>;
  onChange: (people: Person[]) => void;
  onShowCc?: () => void;
  onShowBcc?: () => void;
}

export function RecipientField(p: Props) {
  const [input, setInput] = useState('');
  const [active, setActive] = useState(false);
  const [sugg, setSugg] = useState<Contact[]>([]);
  const [hi, setHi] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const q = input.trim();

  useEffect(() => { if (p.autoFocus) inputRef.current?.focus(); }, [p.autoFocus]);

  useEffect(() => {
    if (!active) return;
    let live = true;
    const t = setTimeout(() => {
      p.search(q).then(list => {
        if (!live) return;
        setSugg(list.filter(c => !p.used.has(c.email.toLowerCase())).slice(0, q ? 5 : 4));
        setHi(0);
      }).catch(() => live && setSugg([]));
    }, q ? 180 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [q, active, p.used]);

  const add = (person: Person | null) => {
    if (!person) return;
    if (!p.people.some(x => x.email.toLowerCase() === person.email.toLowerCase())) p.onChange([...p.people, person]);
    setInput('');
  };
  const commit = () => {
    if (!q) return;
    if (sugg.length && !/@/.test(q)) {
      const s = sugg[Math.min(hi, sugg.length - 1)];
      add({ name: s.name, email: s.email, org: s.org });
    } else add(parsePerson(q, sugg));
  };

  return (
    <div className="field top">
      <span className="field-label">{p.label}</span>
      <div className="chips" onClick={() => inputRef.current?.focus()}>
        {p.people.map((r, i) => {
          const internal = isInternal(r.email, p.orgDomain);
          return (
            <span key={r.email + i} title={r.email} className={'chip' + (r.invalid ? ' invalid' : internal ? ' internal' : '')}>
              <span style={{ whiteSpace: 'nowrap' }}>{r.name}</span>
              {r.invalid ? <span className="tag">INVALID</span> : !internal && <span className="tag">EXT</span>}
              <button aria-label={'Remove ' + r.name} onClick={e => { e.stopPropagation(); p.onChange(p.people.filter((_, j) => j !== i)); }}>×</button>
            </span>
          );
        })}
        <input
          ref={inputRef}
          className="chip-input"
          aria-label={p.label + ' recipients'}
          value={input}
          placeholder={p.people.length ? '' : 'Name or email'}
          onChange={e => setInput(e.target.value)}
          onFocus={() => setActive(true)}
          onBlur={() => { if (q) add(parsePerson(q, sugg)); setActive(false); }}
          onKeyDown={e => {
            if (e.key === 'ArrowDown' && sugg.length) { e.preventDefault(); setHi(h => (h + 1) % sugg.length); }
            else if (e.key === 'ArrowUp' && sugg.length) { e.preventDefault(); setHi(h => (h - 1 + sugg.length) % sugg.length); }
            else if ((e.key === 'Enter' || e.key === ',' || e.key === ';' || e.key === 'Tab') && q) { e.preventDefault(); commit(); }
            else if (e.key === 'Backspace' && !input && p.people.length) p.onChange(p.people.slice(0, -1));
          }}
          onPaste={e => {
            const text = e.clipboardData.getData('text');
            if (!/[,;\n]/.test(text)) return;
            e.preventDefault();
            const parsed = text.split(/[,;\n]+/).map(s => parsePerson(s)).filter((x): x is Person => !!x);
            p.onChange([...p.people, ...parsed.filter(x => !p.people.some(y => y.email === x.email))]);
          }}
        />
      </div>
      {p.onShowCc && (
        <div className="cc-toggles">
          <button onClick={p.onShowCc}>Cc</button>
          <button onClick={p.onShowBcc}>Bcc</button>
        </div>
      )}
      {active && sugg.length > 0 && (
        <div className="popover sugg" role="listbox">
          <span className="mono-label">{q ? 'Contacts' : 'Suggested'}</span>
          {sugg.map((s, i) => (
            <button key={s.email} role="option" aria-selected={i === hi} className={'pop-item' + (i === hi && q ? ' on' : '')}
              onMouseDown={e => { e.preventDefault(); add({ name: s.name, email: s.email, org: s.org }); }}>
              <span className="avatar" style={{ width: 28, height: 28, fontSize: 11 }}>{initials(s.name)}</span>
              <span className="who">
                <b style={{ fontWeight: 600 }}>{s.name}</b>
                <span className="ellipsis">{s.email}</span>
              </span>
              <span className="meta">{s.cat}{s.org ? ' · ' + s.org : ''}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
