import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type Ref } from 'react';
import type { Account, ComposeAttachment, DocumentRef, Identity, OutgoingMessage, Priority, SentResult } from '../../types';
import type { MailProvider } from '../../providers/types';
import type { Assistant, AiResult, RewriteMode } from '../../assistant/types';
import type { ComposeState } from './state';
import { RecipientField } from './RecipientField';
import { SendConfirm } from './SendConfirm';
import { EmailSignature } from '../EmailSignature';
import { usePopover } from '../usePopover';
import { errorText, useToast } from '../Toast';
import { isInternal, sendChecks, validateRecipients } from '../../lib/compose';
import { clockTime, fileExt, formatSize, plural } from '../../lib/format';
import { htmlToText } from '../../lib/html';
import { assembleHtml, assembleText } from '../../lib/outgoing';
import { signatureHtml, signatureText } from '../../lib/signature';
import { CLASS_COLORS, MAX_ATTACHMENT_BYTES, TEMPLATES } from '../../lib/templates';

export interface ComposerHandle {
  /** Save (if there is content) and close. Resolves false if the draft could not be saved. */
  close(silent?: boolean): Promise<boolean>;
}

type Patch = Partial<ComposeState> | ((c: ComposeState) => Partial<ComposeState>);

interface Props {
  compose: ComposeState;
  update: (p: Patch) => void;
  provider: MailProvider;
  assistant: Assistant;
  account: Account;
  identities: Identity[];
  handleRef: Ref<ComposerHandle>;
  onClosed: () => void;
  onSent: (r: SentResult, msg: OutgoingMessage) => void;
  onDraftsChanged: () => void;
  onOpenDraft: (draftId: string) => void;
}

const FORMATS: { glyph: string; title: string; cmd: string; arg?: string; style?: CSSProperties }[] = [
  { glyph: 'B', title: 'Bold', cmd: 'bold', style: { fontWeight: 700 } },
  { glyph: 'I', title: 'Italic', cmd: 'italic', style: { fontStyle: 'italic' } },
  { glyph: 'U', title: 'Underline', cmd: 'underline', style: { textDecoration: 'underline' } },
  { glyph: '•', title: 'Bulleted list', cmd: 'insertUnorderedList' },
  { glyph: '1.', title: 'Numbered list', cmd: 'insertOrderedList' },
  { glyph: '❝', title: 'Quote', cmd: 'formatBlock', arg: 'blockquote' },
  { glyph: '↗', title: 'Link', cmd: 'createLink' },
  { glyph: 'Tx', title: 'Clear formatting', cmd: 'removeFormat', style: { textDecoration: 'line-through' } }
];

const AI_CHIPS: [string, RewriteMode][] = [['Shorter', 'shorter'], ['More formal', 'formal'], ['Warmer', 'warmer'], ['Clearer', 'clarity'], ['Translate to French', 'translate']];

const secureClass = (cls: string) => cls === 'Confidential' || cls === 'Restricted';

export function Composer(p: Props) {
  const { compose: c, update, provider, assistant, account, identities } = p;
  const toast = useToast();
  const editorRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const latest = useRef(c);
  latest.current = c;
  const draftId = useRef<string | undefined>(c.draftId);
  const chain = useRef<Promise<boolean>>(Promise.resolve(true));
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const closed = useRef(false);

  const [dirty, setDirty] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [sending, setSending] = useState(false);
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [undoHtml, setUndoHtml] = useState<string | null>(null);
  const [docs, setDocs] = useState<DocumentRef[]>([]);

  const fromPop = usePopover();
  const tplPop = usePopover();
  const docPop = usePopover();
  const schedPop = usePopover();

  const identity = identities.find(i => i.id === c.fromId) || identities[0];
  const defaultId = (identities.find(i => i.isDefault) || identities[0])?.id;
  const sigHtml = useMemo(() => signatureHtml(account.profile), [account.profile]);
  const schedules = provider.scheduleOptions();
  const caps = provider.capabilities;

  useLayoutEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    el.innerHTML = latest.current.html;
    if (latest.current.to.length) {
      el.focus();
      const sel = window.getSelection();
      sel?.selectAllChildren(el);
      sel?.collapseToStart();
    }
  }, []);

  useEffect(() => {
    if (caps.documents) provider.documents().then(setDocs).catch(() => {});
  }, [provider, caps.documents]);

  const getHtml = () => editorRef.current?.innerHTML ?? latest.current.html;
  const getText = () => htmlToText(getHtml());
  const hasContent = (x: ComposeState) =>
    !!(x.to.length || x.cc.length || x.bcc.length || x.subject.trim() || getText() || x.attachments.length);

  const build = useCallback((x: ComposeState): OutgoingMessage => {
    const bodyHtml = editorRef.current?.innerHTML ?? x.html;
    const sig = x.signature ? sigHtml : null;
    return {
      identity: identities.find(i => i.id === x.fromId) || identities[0],
      to: x.to, cc: x.cc, bcc: x.bcc, subject: x.subject,
      html: assembleHtml(bodyHtml, sig, x.quote),
      text: assembleText(htmlToText(bodyHtml), sig ? signatureText(account.profile) : null, x.quote),
      attachments: x.attachments, priority: x.priority, reply: x.reply ?? undefined,
      draftId: draftId.current, schedule: x.schedule, note: x.note
    };
  }, [identities, sigHtml, account.profile]);

  /** Queue a draft save behind any save in flight, so drafts are never created twice. */
  const save = useCallback((): Promise<boolean> => {
    chain.current = chain.current.then(async () => {
      const x = latest.current;
      if (!hasContent(x)) return true;
      update({ saving: true });
      try {
        const r = await provider.saveDraft(build(x));
        draftId.current = r.draftId;
        update({ draftId: r.draftId, saving: false, savedAt: clockTime() });
        p.onDraftsChanged();
        return true;
      } catch (e) {
        update({ saving: false });
        setError('Draft not saved: ' + errorText(e));
        return false;
      }
    });
    return chain.current;
  }, [provider, build, update]);

  const touch = () => { setError(null); setDirty(n => n + 1); };
  const patch = (x: Patch) => { update(x); touch(); };

  useEffect(() => {
    if (!dirty || closed.current) return;
    timer.current = setTimeout(() => { if (!closed.current) save(); }, caps.demo ? 700 : 1500);
    return () => clearTimeout(timer.current);
  }, [dirty, save, caps.demo]);

  const close = async (silent = false): Promise<boolean> => {
    clearTimeout(timer.current);
    const x = latest.current;
    if (hasContent(x)) {
      const ok = await save();
      if (!ok) return false;
      closed.current = true;
      const id = draftId.current;
      if (!silent && id) toast({ text: 'Draft saved', action: 'Open', onAction: () => p.onOpenDraft(id) });
    } else {
      closed.current = true;
      await chain.current;
      if (draftId.current) {
        await provider.deleteDraft(draftId.current).catch(() => {});
        p.onDraftsChanged();
      }
    }
    p.onClosed();
    return true;
  };

  useImperativeHandle(p.handleRef, () => ({ close }));

  const discard = async () => {
    closed.current = true;
    clearTimeout(timer.current);
    await chain.current;
    if (draftId.current) {
      try { await provider.deleteDraft(draftId.current); } catch (e) { toast({ text: 'Could not delete the draft: ' + errorText(e), error: true }); }
      p.onDraftsChanged();
    }
    p.onClosed();
    toast('Draft discarded');
  };

  const doSend = async () => {
    setSending(true);
    clearTimeout(timer.current);
    closed.current = true;
    await chain.current;
    const msg = build(latest.current);
    try {
      const r = await provider.send(msg);
      p.onSent(r, msg);
      p.onClosed();
    } catch (e) {
      closed.current = false;
      setConfirm(false);
      setError('Not sent: ' + errorText(e));
    } finally {
      setSending(false);
    }
  };

  const send = () => {
    const x = latest.current;
    const err = validateRecipients(x.to, x.cc, x.bcc);
    if (err) return setError(err);
    if (!x.subject.trim() && !getText()) return setError('The message is empty.');
    const total = x.attachments.reduce((n, a) => n + (a.secure ? 0 : a.size), 0);
    if (!caps.demo && total > MAX_ATTACHMENT_BYTES) return setError('Attachments total ' + formatSize(total) + '. Gmail accepts up to about 18 MB of files per message.');
    if (checks().length) return setConfirm(true);
    doSend();
  };

  const checks = () => sendChecks({
    identity, defaultIdentityId: defaultId, to: c.to, cc: c.cc, bcc: c.bcc, subject: c.subject, text: getText(),
    attachments: c.attachments, orgDomain: provider.orgDomain
  });

  // Keyboard: ⌘/Ctrl+Enter sends, Escape minimizes.
  const sendRef = useRef(send);
  sendRef.current = send;
  useEffect(() => {
    if (c.minimized) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); sendRef.current(); }
      else if (e.key === 'Escape' && !e.defaultPrevented) update({ minimized: true });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [c.minimized, update]);

  const setBody = (html: string, note: ComposeState['aiNote']) => {
    setUndoHtml(getHtml());
    if (editorRef.current) editorRef.current.innerHTML = html;
    patch({ html, aiNote: note });
  };

  const applyAi = (r: AiResult) => {
    if (r.html) setBody(r.html, r.note);
    else update({ aiNote: r.note });
  };

  const runAi = async (fn: () => Promise<AiResult>) => {
    setAiBusy(true);
    try { applyAi(await fn()); } catch (e) { update({ aiNote: { title: 'Assistant error.', text: errorText(e) } }); } finally { setAiBusy(false); }
  };

  const aiDraft = () => runAi(() => assistant.draft({
    thread: c.context, instruction: aiPrompt, recipientFirstName: c.to[0]?.name.split(' ')[0] || ''
  }));
  const aiRewrite = (mode: RewriteMode) => {
    if (!getText()) return update({ aiNote: { title: 'Nothing to rewrite.', text: 'Write or draft the message first.' } });
    runAi(() => assistant.rewrite(getHtml(), mode, c.context));
  };

  const fmt = (cmd: string, arg?: string) => (e: ReactMouseEvent) => {
    e.preventDefault();
    if (cmd === 'createLink') {
      const u = window.prompt('Link URL', 'https://');
      if (!u) return;
      arg = u;
    }
    document.execCommand(cmd, false, arg);
    if (editorRef.current) update({ html: editorRef.current.innerHTML });
    touch();
  };

  const addAttachment = (a: Omit<ComposeAttachment, 'id'>) =>
    patch(x => ({ attachments: [...x.attachments, { ...a, id: Math.random().toString(36).slice(2) }] }));

  const onFiles = (files: FileList | null) => {
    Array.from(files || []).forEach(f => addAttachment({
      name: f.name, ext: fileExt(f.name), size: f.size, mime: f.type || 'application/octet-stream', cls: 'Not classified', secure: false,
      source: { kind: 'file', blob: f }
    }));
  };

  const all = [...c.to, ...c.cc, ...c.bcc];
  const used = useMemo(() => new Set([...c.to, ...c.cc, ...c.bcc].map(x => x.email.toLowerCase())), [c.to, c.cc, c.bcc]);
  const ext = all.filter(x => !x.invalid && !isInternal(x.email, provider.orgDomain));
  const orgs = [...new Set(ext.map(x => x.org).filter(Boolean))];
  const status = c.saving ? 'Saving…' : c.savedAt ? 'Draft saved · ' + c.savedAt : 'Not saved yet';
  const title = c.mode === 'reply' ? 'Reply' : c.mode === 'forward' ? 'Forward' : 'New message';
  const search = useCallback((q: string) => provider.searchContacts(q), [provider]);

  const confirmRows = () => {
    const names = (arr: typeof c.to) => arr.map(x => x.name + (isInternal(x.email, provider.orgDomain) ? '' : ' (external)')).join(', ');
    const rows = [{ k: 'FROM', v: identity.name + ' <' + identity.addr + '>' }, { k: 'TO', v: names(c.to) || '—' }];
    if (c.cc.length) rows.push({ k: 'CC', v: names(c.cc) });
    if (c.bcc.length) rows.push({ k: 'BCC', v: names(c.bcc) });
    rows.push({ k: 'SUBJECT', v: c.subject || '(no subject)' });
    rows.push({ k: 'ATTACHMENTS', v: c.attachments.length ? c.attachments.map(a => a.name + ' · ' + a.cls + (a.secure ? ' · secure link' : '')).join('; ') : 'None' });
    rows.push({ k: 'WHEN', v: c.schedule ? c.schedule.when : 'Now' });
    if (c.note) rows.push({ k: 'INTERNAL NOTE', v: 'Stays on the thread. Not included in the email.' });
    return rows;
  };

  return (
    <>
      {c.minimized && (
        <button className="composer-mini" onClick={() => update({ minimized: false })}>
          <span className="title ellipsis">{c.subject || title}</span>
          <span className="status">{status}</span>
          <span className="faint">▴</span>
        </button>
      )}
      {c.expanded && !c.minimized && <div className="composer-scrim" onClick={() => update({ minimized: true })} />}
      <section className={'composer' + (c.expanded ? ' expanded' : '')} hidden={c.minimized} aria-label={title} role="dialog">
        <div className="composer-bar">
          <b>{title}</b>
          {c.priority === 'High' && <span className="pill danger" style={{ border: 0 }}>High priority</span>}
          <span className="status">{status}</span>
          <div className="tools">
            <button className="bar-btn" title="Minimize (Esc)" aria-label="Minimize" onClick={() => update({ minimized: true })}>—</button>
            <button className="bar-btn" title={c.expanded ? 'Dock' : 'Expand'} aria-label={c.expanded ? 'Dock' : 'Expand'} onClick={() => update({ expanded: !c.expanded })}>{c.expanded ? '⤡' : '⤢'}</button>
            <button className="bar-btn" title="Save draft and close" aria-label="Save draft and close" style={{ fontSize: 16 }} onClick={() => close()}>×</button>
          </div>
        </div>

        <div className="composer-fields">
          <div className="field" ref={fromPop.ref}>
            <span className="field-label">FROM</span>
            <button className="from-btn" onClick={fromPop.toggle} aria-haspopup="listbox" aria-expanded={fromPop.open}>
              <b>{identity.name}</b>
              <span className="addr">&lt;{identity.addr}&gt;</span>
              <span className="faint">▾</span>
            </button>
            <span className={'pill' + (identity.id === defaultId ? '' : ' accent')} style={{ fontSize: 11, padding: '2px 8px' }}>{identity.short}</span>
            {fromPop.open && (
              <div className="popover" style={{ top: 40, left: 54, width: 400, maxWidth: 'calc(100% - 54px)' }} role="listbox">
                <span className="mono-label">Send as · authorized identities</span>
                {identities.map(i => (
                  <button key={i.id} role="option" aria-selected={i.id === c.fromId} className={'pop-item' + (i.id === c.fromId ? ' sel' : '')}
                    style={{ alignItems: 'flex-start' }} onClick={() => { patch({ fromId: i.id }); fromPop.setOpen(false); }}>
                    <span style={{ width: 14, color: 'var(--accent)', fontWeight: 700 }}>{i.id === c.fromId ? '✓' : ''}</span>
                    <span style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <span><b style={{ fontWeight: 600 }}>{i.name}</b> <span className="muted">&lt;{i.addr}&gt;</span></span>
                      <span className="muted" style={{ fontSize: 11.5 }}>{i.kind}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
          {identity.note && <div className="notice accent from-note">{identity.note}</div>}

          <RecipientField label="TO" people={c.to} orgDomain={provider.orgDomain} used={used} search={search} autoFocus={!c.to.length}
            onChange={to => patch({ to })} onShowCc={() => update({ showCc: true })} onShowBcc={() => update({ showBcc: true })} />
          {c.showCc && <RecipientField label="CC" people={c.cc} orgDomain={provider.orgDomain} used={used} search={search} onChange={cc => patch({ cc })} />}
          {c.showBcc && <RecipientField label="BCC" people={c.bcc} orgDomain={provider.orgDomain} used={used} search={search} onChange={bcc => patch({ bcc })} />}

          {ext.length > 0 && (
            <div className="ext-warning">
              <span className="dot" />
              <span>{plural(ext.length, 'external recipient')}{orgs.length ? ' · ' + orgs.join(', ') : ''}</span>
            </div>
          )}

          <div className="field">
            <label className="field-label" htmlFor={'subject-' + c.key}>SUBJECT</label>
            <input id={'subject-' + c.key} className="subject-input" value={c.subject} placeholder="Subject" onChange={e => patch({ subject: e.target.value })} />
          </div>

          <div className="toolbar">
            {FORMATS.map(f => (
              <button key={f.title} className="fmt" title={f.title} aria-label={f.title} style={f.style} onMouseDown={fmt(f.cmd, f.arg)}>{f.glyph}</button>
            ))}
            <span className="sep" />
            <div style={{ position: 'relative' }} ref={tplPop.ref}>
              <button className="fmt" onClick={tplPop.toggle} aria-expanded={tplPop.open}>Templates ▾</button>
              {tplPop.open && (
                <div className="popover" style={{ top: 34, left: 0, width: 340 }}>
                  <span className="mono-label">Approved templates</span>
                  {TEMPLATES.map(t => (
                    <button key={t.name} className="pop-item" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}
                      onClick={() => {
                        if (!c.subject) update({ subject: t.subject });
                        setBody(t.html, { title: 'Template inserted:', text: t.name + '. Replace the bracketed fields.' });
                        tplPop.setOpen(false);
                      }}>
                      <b style={{ fontWeight: 600 }}>{t.name}</b><span className="muted" style={{ fontSize: 11.5 }}>{t.meta}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button className="fmt" onClick={() => patch({ signature: !c.signature })}>Signature: {c.signature ? 'Standard' : 'Off for this message'}</button>
          </div>
        </div>

        <div className="composer-scroll">
          {c.aiNote && (
            <div className="notice accent ai-note">
              <span>✦</span>
              <span style={{ flex: 1 }}><b>{c.aiNote.title}</b> {c.aiNote.text}</span>
              {undoHtml != null && (
                <button className="link-btn" style={{ whiteSpace: 'nowrap' }} onClick={() => {
                  if (editorRef.current) editorRef.current.innerHTML = undoHtml;
                  setUndoHtml(null);
                  patch({ html: undoHtml, aiNote: null });
                }}>Undo</button>
              )}
            </div>
          )}
          <div
            ref={editorRef}
            className="editor"
            contentEditable
            suppressContentEditableWarning
            role="textbox"
            aria-multiline="true"
            aria-label="Message body"
            onInput={() => { update({ html: editorRef.current!.innerHTML }); touch(); }}
          />
          {c.signature && <EmailSignature profile={account.profile} />}
          {c.quote && (
            <details className="quote">
              <summary>On {c.quote.time}, {c.quote.who} wrote… (quoted)</summary>
              <div>{c.quote.text}</div>
            </details>
          )}
          {c.forwardable.length > 0 && (
            <div className="forwardable">
              <span className="muted" style={{ fontSize: 12 }}>Attachments from the original message are not included automatically.</span>
              <div className="row-wrap">
                {c.forwardable.map(a => (
                  <button key={a.name} className="btn sm" onClick={() => {
                    const cls = docs.find(d => d.name === a.name)?.cls || 'Not classified';
                    addAttachment({
                      name: a.name, ext: a.ext, size: a.size, mime: a.mime, cls, secure: secureClass(cls),
                      source: { kind: 'remote', messageId: a.messageId || '', attachmentId: a.attachmentId || '' }
                    });
                    update(x => ({ forwardable: x.forwardable.filter(f => f.name !== a.name) }));
                  }}>+ {a.name}</button>
                ))}
              </div>
            </div>
          )}
          {c.attachments.length > 0 && (
            <div className="row-wrap" style={{ gap: 8 }}>
              {c.attachments.map(a => {
                const [bg, fg] = CLASS_COLORS[a.cls] || CLASS_COLORS['Not classified'];
                return (
                  <div key={a.id} className="att-card">
                    <span className="ext-tag">{a.ext}</span>
                    <span className="info">
                      <b className="ellipsis">{a.name}</b>
                      <span>{a.secure ? 'Secure link · named recipients · expires in 14 days' : formatSize(a.size)}</span>
                    </span>
                    <span className="pill" style={{ background: bg, color: fg }}>{a.cls}</span>
                    <button className="x-btn" title="Remove" aria-label={'Remove ' + a.name}
                      onClick={() => patch(x => ({ attachments: x.attachments.filter(y => y.id !== a.id) }))}>×</button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {c.noteOpen && (
          <div className="note-box">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span className="mono-label">Internal note</span>
              <span>{caps.sharedNotes ? 'Saved to the thread for the Axal team. Never included in the email.' : 'Saved with the conversation on this device. Never included in the email.'}</span>
            </div>
            <textarea rows={2} value={c.note} aria-label="Internal note" placeholder="e.g. Priya to join the Thursday call" onChange={e => patch({ note: e.target.value })} />
          </div>
        )}

        {c.aiBar && (
          <div className="ai-bar">
            <div className="ai-bar-row">
              <span style={{ color: 'var(--accent)', padding: '0 4px' }}>✦</span>
              <input value={aiPrompt} aria-label="Assistant instruction" placeholder="Tell the assistant what to write…" onChange={e => setAiPrompt(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); aiDraft(); } }} />
              <button className="btn primary sm" disabled={aiBusy} onClick={aiDraft}>{aiBusy ? 'Working…' : 'Draft'}</button>
            </div>
            <div className="row-wrap" style={{ gap: 5 }}>
              {AI_CHIPS.map(([label, mode]) => (
                <button key={mode} className="ai-chip" disabled={aiBusy || !assistant.live} title={assistant.live ? undefined : 'Needs the assistant backend'}
                  onClick={() => aiRewrite(mode)}>{label}</button>
              ))}
            </div>
          </div>
        )}

        {error && <div className="notice danger composer-error" role="alert">{error}</div>}

        <div className="composer-foot">
          <div className="send-split" ref={schedPop.ref}>
            <button className="btn primary lg" title="Send (⌘↵)" disabled={sending} onClick={send}>{sending ? 'Sending…' : c.schedule ? 'Schedule' : 'Send'}</button>
            {caps.schedule && (
              <>
                <button className="btn primary lg caret" title="Schedule send" aria-label="Schedule send" onClick={schedPop.toggle}>▾</button>
                {schedPop.open && (
                  <div className="popover" style={{ bottom: 52, left: 12, width: 260 }}>
                    <span className="mono-label">Send later</span>
                    {[{ label: 'Send now', when: '' }, ...schedules].map(o => (
                      <button key={o.label} className="pop-item" style={{ justifyContent: 'space-between' }}
                        onClick={() => { patch({ schedule: o.when ? o : null }); schedPop.setOpen(false); }}>
                        <span>{o.label}</span><span className="mono muted" style={{ fontSize: 11 }}>{o.when}</span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
          {c.schedule && <button className="sched-text" title="Clear schedule" onClick={() => patch({ schedule: null })}>{c.schedule.when} ×</button>}
          <span className="sep" />
          <button className="btn ghost" title="Attach file" onClick={() => fileRef.current?.click()}>⎘ Attach</button>
          <input type="file" multiple ref={fileRef} style={{ display: 'none' }} onChange={e => { onFiles(e.target.files); e.target.value = ''; }} />
          {caps.documents && (
            <div style={{ position: 'relative' }} ref={docPop.ref}>
              <button className="btn ghost" onClick={docPop.toggle} aria-expanded={docPop.open}>▤ Document</button>
              {docPop.open && (
                <div className="popover" style={{ bottom: 42, left: 0, width: 400 }}>
                  <span className="mono-label">From documents · you have access</span>
                  {docs.map(d => {
                    const [bg, fg] = CLASS_COLORS[d.cls];
                    return (
                      <button key={d.id} className="pop-item" onClick={() => {
                        addAttachment({ name: d.name, ext: d.ext, size: d.size, mime: 'application/octet-stream', cls: d.cls, secure: secureClass(d.cls), source: { kind: 'doc', docId: d.id } });
                        docPop.setOpen(false);
                      }}>
                        <span className="ext-tag">{d.ext}</span>
                        <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                          <span style={{ fontWeight: 500 }}>{d.name}</span>
                          <span className="muted" style={{ fontSize: 11 }}>{secureClass(d.cls) ? 'Shared as a secure link, not a file' : 'Attached as a file · ' + formatSize(d.size)}</span>
                        </span>
                        <span className="pill" style={{ background: bg, color: fg }}>{d.cls}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
          <button className="btn ghost" style={{ color: 'var(--accent-strong)', background: c.aiBar ? 'var(--accent-soft)' : undefined }} onClick={() => update({ aiBar: !c.aiBar })}>✦ AI</button>
          <button className="btn ghost" style={{ color: 'var(--warn)', background: c.noteOpen ? 'var(--warn-bg)' : undefined }} onClick={() => update({ noteOpen: !c.noteOpen })}>✎ Note</button>
          <select aria-label="Priority" value={c.priority} onChange={e => patch({ priority: e.target.value as Priority })}>
            <option value="Normal">Normal priority</option>
            <option value="High">High priority</option>
            <option value="Low">Low priority</option>
          </select>
          <button className="btn ghost danger discard" title="Discard draft" onClick={discard}>Discard</button>
        </div>
      </section>

      {confirm && !c.minimized && (
        <SendConfirm reasons={checks()} rows={confirmRows()} action={c.schedule ? 'Schedule' : 'Send'} busy={sending}
          onCancel={() => setConfirm(false)} onConfirm={doSend} />
      )}
    </>
  );
}
