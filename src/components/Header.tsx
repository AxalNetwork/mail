import { useEffect, useState, type RefObject } from 'react';
import type { Account, Mailbox } from '../types';
import { Avatar } from './Avatar';
import { usePopover } from './usePopover';

interface Props {
  account: Account | null;
  mailbox: string;
  mailboxes: Mailbox[];
  query: string;
  searchRef: RefObject<HTMLInputElement | null>;
  signOutLabel: string;
  onPickMailbox: (addr: string) => void;
  onSearch: (q: string) => void;
  onToggleAssistant: () => void;
  onBulk: () => void;
  onCompose: () => void;
  onToggleNav: () => void;
  onSignOut: () => void;
}

export function Header(p: Props) {
  const mb = usePopover();
  const me = usePopover();
  const [q, setQ] = useState(p.query);
  useEffect(() => setQ(p.query), [p.query]);

  return (
    <header className="topbar">
      <button className="btn ghost sm menu-btn" aria-label="Open navigation" onClick={p.onToggleNav}>☰</button>
      <div className="brand">
        <img className="brand-mark" src="/logo.png" alt="" width={28} height={27} />
        <span className="brand-name">Axal VC</span>
        <span className="brand-tag">MAIL</span>
      </div>
      <div style={{ position: 'relative' }} ref={mb.ref}>
        <button className="mailbox-btn" onClick={mb.toggle} aria-haspopup="menu" aria-expanded={mb.open}>
          <span className="mono-key label">MAILBOX</span>
          <span className="addr">{p.mailbox}</span>
          <span className="faint">▾</span>
        </button>
        {mb.open && (
          <div className="popover" style={{ top: 38, left: 0, width: 320 }} role="menu">
            <span className="mono-label">Authorized mailboxes</span>
            {p.mailboxes.map(m => (
              <button key={m.addr} role="menuitem" className={'pop-item' + (m.addr === p.mailbox ? ' sel' : '')}
                style={{ justifyContent: 'space-between' }}
                onClick={() => { p.onPickMailbox(m.addr); mb.setOpen(false); }}>
                <span style={{ fontWeight: 500 }}>{m.addr}</span>
                <span className="muted" style={{ fontSize: 11 }}>{m.access}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <form className="search" role="search" onSubmit={e => { e.preventDefault(); p.onSearch(q.trim()); }}>
        <label className="sr-only" htmlFor="mail-search">Search mail</label>
        <input id="mail-search" ref={p.searchRef} value={q} onChange={e => setQ(e.target.value)}
          onKeyDown={e => { if (e.key === 'Escape') { setQ(''); p.onSearch(''); (e.target as HTMLInputElement).blur(); } }}
          placeholder="Search mail, contacts and documents" autoComplete="off" />
        {q ? <button type="button" className="x-btn" aria-label="Clear search" onClick={() => { setQ(''); p.onSearch(''); }}>×</button>
          : <span className="kbd">/</span>}
      </form>
      <div className="topbar-actions">
        <button className="btn assistant-toggle" onClick={p.onToggleAssistant}><span style={{ color: 'var(--accent)' }}>✦</span>Assistant</button>
        <button className="btn bulk-btn" onClick={p.onBulk}>Bulk email</button>
        <button className="btn primary compose-btn" title="Compose (C)" onClick={p.onCompose}>
          Compose<span className="kbd wide-only">C</span>
        </button>
        <div className="divider" />
        <div className="me" ref={me.ref}>
          <button className="me-btn" onClick={me.toggle} aria-haspopup="menu" aria-expanded={me.open} aria-label="Account">
            <Avatar name={p.account?.name || ''} photoUrl={p.account?.photoUrl} accent size={30} />
            <span className="me-text">
              <b>{p.account?.name}</b>
              <span>{p.account?.title}</span>
            </span>
          </button>
          {me.open && (
            <div className="popover" style={{ top: 40, right: 0, width: 260 }} role="menu">
              <span className="mono-label">Signed in</span>
              <div style={{ padding: '0 8px 8px', overflowWrap: 'anywhere' }}>{p.account?.email}</div>
              <button className="pop-item" role="menuitem" onClick={() => { me.setOpen(false); p.onSignOut(); }}>{p.signOutLabel}</button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
