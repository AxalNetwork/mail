import { usePopover } from '../usePopover';

/** "Save to Documents" next to an email attachment: pick the Drive folder, or open the copy already saved. */
export function SaveAttachment({ name, categories, saved, busy, onSave, onOpen }: {
  name: string; categories: string[]; saved: boolean; busy: boolean; onSave: (category: string) => void; onOpen: () => void;
}) {
  const { open, setOpen, toggle, ref } = usePopover<HTMLSpanElement>();
  if (saved) return <button className="btn ghost sm" onClick={onOpen} title={name + ' is in Documents'}>Saved ✓</button>;
  return (
    <span className="snooze-wrap" ref={ref}>
      <button className="btn ghost sm" disabled={busy} onClick={toggle} aria-haspopup="menu" aria-expanded={open} aria-label={'Save ' + name + ' to Documents'}>
        {busy ? 'Saving…' : 'Save to Documents'}
      </button>
      {open && (
        <div className="card snooze-menu" role="menu" aria-label={'Save ' + name + ' to'}>
          {categories.map(c => <button key={c} role="menuitem" className="snooze-item" onClick={() => { setOpen(false); onSave(c); }}>{c}</button>)}
        </div>
      )}
    </span>
  );
}
