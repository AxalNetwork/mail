import { useEffect, useRef, useState } from 'react';
import type { Thread } from '../../types';
import type { Suggestion, Task, TaskInput, TasksApi } from '../../lib/tasksApi';
import { TasksError } from '../../lib/tasksApi';
import { errorText } from '../Toast';
import { TaskForm, type Member } from './TaskForm';

interface Props {
  api: TasksApi;
  /** The conversation the task comes from (absent for a task made from scratch). */
  thread?: Thread;
  mailbox?: string;
  /** Prefill, e.g. a follow-up from AI Automations. */
  initial?: Partial<TaskInput>;
  /** Whether the assistant can suggest action items. */
  canSuggest: boolean;
  userName?: string;
  onCreated: (t: Task[]) => void;
  onClose: () => void;
}

const KIND_TEXT: Record<Suggestion['kind'], string> = { request: 'Asked of you', commitment: 'You said you would', follow_up: 'Waiting on them' };

/** Slim copy of the conversation for the assistant (the same shape the other assistant calls send). */
const slim = (t: Thread) => ({
  id: t.id, subject: t.subject, labels: t.labels,
  messages: t.messages.slice(-12).map(m => ({ from: m.from, email: m.email, to: m.to, time: m.time, text: m.text.slice(0, 8000), attachments: m.attachments.map(a => a.name) }))
});

/** Create a task, from an email or from scratch. AI suggestions are only proposals: each one is reviewed and ticked before it becomes a task. */
export function CreateTaskDialog({ api, thread, mailbox, initial, canSuggest, userName, onCreated, onClose }: Props) {
  const [members, setMembers] = useState<{ members: Member[]; you: string } | null>(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [suggestions, setSuggestions] = useState<(Suggestion & { pick: boolean; title: string })[] | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => { api.members().then(setMembers).catch(e => setErr(errorText(e))); }, [api]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const source = thread ? { sourceMailbox: mailbox || '', sourceThreadId: thread.id, sourceSubject: thread.subject } : {};

  const create = async (t: TaskInput) => {
    setBusy('create'); setErr('');
    try { onCreated([await api.create({ ...initial, ...t, ...source })]); } catch (e) { setErr(errorText(e)); } finally { setBusy(''); }
  };

  const suggest = async () => {
    if (!thread) return;
    setBusy('suggest'); setErr('');
    try {
      const s = await api.suggest(slim(thread), userName);
      setSuggestions(s.map(x => ({ ...x, pick: false })));
    } catch (e) {
      setErr(e instanceof TasksError && e.code === 'assistant_off' ? 'The assistant isn’t connected on this server, so it can’t suggest tasks.' : errorText(e));
    } finally { setBusy(''); }
  };

  const createPicked = async () => {
    const picked = (suggestions || []).filter(s => s.pick && s.title.trim().length >= 2);
    if (!picked.length) return;
    setBusy('create'); setErr('');
    const made: Task[] = [];
    try {
      for (const s of picked) {
        made.push(await api.create({
          title: s.title.trim(),
          // The quote is kept so anyone can check the task against what the email actually says.
          description: [s.detail, s.quote ? '“' + s.quote + '”' + (s.quoteVerified ? '' : ' (not found word for word in the email)') : '', s.dueText ? 'The email mentions: ' + s.dueText + '. No due date was set.' : ''].filter(Boolean).join('\n\n'),
          createdVia: 'ai_suggested', ...source
        }));
      }
      onCreated(made);
    } catch (e) {
      if (made.length) onCreated(made);
      setErr(errorText(e));
    } finally { setBusy(''); }
  };

  return (
    <div className="modal-scrim" onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal task-modal" role="dialog" aria-modal="true" aria-labelledby="task-dialog-title" ref={ref}>
        <div className="modal-head">
          <span className="mono-label" style={{ color: 'var(--accent-strong)' }}>Tasks</span>
          <h3 id="task-dialog-title">{thread ? 'Create a task from this email' : 'New task'}</h3>
          {thread && <span className="muted" style={{ fontSize: 12.5 }}>“{thread.subject || '(no subject)'}”. The task links back to this conversation.</span>}
        </div>
        <div className="bug-body">
          {err && <div className="notice warn" role="alert">{err}</div>}
          {!members ? <div className="an-loading"><div className="spinner" /> Loading…</div> : suggestions ? (
            <>
              <span className="notice accent">Suggestions come from the email’s text. They are not commitments: tick only what the team will actually do, and set a due date yourself afterwards.</span>
              {!suggestions.length && <span className="faint">No action items found in this conversation.</span>}
              {suggestions.map((s, i) => (
                <div key={i} className="suggestion">
                  <label className="check-row">
                    <input type="checkbox" checked={s.pick} onChange={() => setSuggestions(l => l!.map((x, k) => (k === i ? { ...x, pick: !x.pick } : x)))} />
                    <input className="input" aria-label={'Suggested task ' + (i + 1)} value={s.title} onChange={e => setSuggestions(l => l!.map((x, k) => (k === i ? { ...x, title: e.target.value } : x)))} />
                  </label>
                  <span className="muted" style={{ fontSize: 12 }}>{KIND_TEXT[s.kind]}{s.dueText ? ' · mentions “' + s.dueText + '”' : ''} · {s.detail}</span>
                  {s.quote && <span className={s.quoteVerified ? 'faint' : 'tone-warn'} style={{ fontSize: 12 }}>“{s.quote}”{s.quoteVerified ? '' : ' — not found word for word in the email; check it'}</span>}
                </div>
              ))}
              <div className="row-wrap">
                <button className="btn primary sm" disabled={!!busy || !suggestions.some(s => s.pick)} onClick={createPicked}>
                  {busy === 'create' ? 'Creating…' : 'Create ' + suggestions.filter(s => s.pick).length + ' task' + (suggestions.filter(s => s.pick).length === 1 ? '' : 's')}
                </button>
                <button className="btn ghost sm" onClick={() => setSuggestions(null)}>Write one instead</button>
              </div>
            </>
          ) : (
            <>
              <TaskForm members={members.members} you={members.you} busy={busy === 'create'} submitLabel="Create task"
                initial={{ title: initial?.title ?? (thread ? (thread.subject ? 'Follow up: ' + thread.subject : '') : ''), ...initial }}
                onCancel={onClose} onSubmit={create} />
              {thread && canSuggest && (
                <button className="btn ghost sm" style={{ alignSelf: 'flex-start' }} disabled={!!busy} onClick={suggest}>{busy === 'suggest' ? 'Reading the email…' : '✦ Suggest tasks from this email'}</button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
