import { useState } from 'react';
import type { Task, TaskInput, TaskPriority, TaskStatus } from '../../lib/tasksApi';
import { PRIORITY_LABEL, STATUS_LABEL } from '../../lib/tasksApi';

export interface Member { email: string; name: string }

/** yyyy-mm-dd in local time, for <input type="date">. */
export const dateInput = (ms: number | null) => {
  if (ms == null) return '';
  const d = new Date(ms);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};
/** End of the chosen day, local time. */
export const fromDateInput = (s: string) => (s ? new Date(s + 'T23:59:00').getTime() : null);

export const dueText = (ms: number | null, now = Date.now()) => {
  if (ms == null) return '';
  const d = new Date(ms);
  const label = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  return ms < now ? 'Overdue · ' + label : 'Due ' + label;
};

export const memberName = (members: Member[], email: string | null) => (email ? members.find(m => m.email === email)?.name || email : 'Unassigned');

interface Props {
  members: Member[];
  you: string;
  initial?: Partial<TaskInput> & { status?: TaskStatus };
  /** Editing an existing task shows its status too. */
  task?: Task;
  busy?: boolean;
  submitLabel: string;
  onSubmit: (t: TaskInput & { status?: TaskStatus }) => void;
  onCancel: () => void;
}

export function TaskForm({ members, you, initial = {}, task, busy, submitLabel, onSubmit, onCancel }: Props) {
  const [title, setTitle] = useState(task?.title ?? initial.title ?? '');
  const [description, setDescription] = useState(task?.description ?? initial.description ?? '');
  const [assignee, setAssignee] = useState<string>(task ? task.assignee || '' : initial.assignee === undefined ? you : initial.assignee || '');
  const [priority, setPriority] = useState<TaskPriority>(task?.priority ?? initial.priority ?? 'normal');
  const [status, setStatus] = useState<TaskStatus>(task?.status ?? initial.status ?? 'open');
  const [due, setDue] = useState(dateInput(task?.dueAt ?? initial.dueAt ?? null));

  return (
    <form className="task-form" onSubmit={e => {
      e.preventDefault();
      if (title.trim().length < 2) return;
      onSubmit({ title: title.trim(), description, assignee: assignee || null, priority, dueAt: fromDateInput(due), ...(task ? { status } : {}) });
    }}>
      <label className="tf-field">Title
        <input className="input" value={title} onChange={e => setTitle(e.target.value)} maxLength={200} required autoFocus />
      </label>
      <label className="tf-field">Description
        <textarea className="textarea" rows={3} value={description} onChange={e => setDescription(e.target.value)} maxLength={5000} />
      </label>
      <div className="row-wrap">
        <label className="tf-field">Assignee
          <select className="input" value={assignee} onChange={e => setAssignee(e.target.value)}>
            <option value="">Unassigned</option>
            {members.map(m => <option key={m.email} value={m.email}>{m.email === you ? m.name + ' (you)' : m.name}</option>)}
          </select>
        </label>
        <label className="tf-field">Priority
          <select className="input" value={priority} onChange={e => setPriority(e.target.value as TaskPriority)}>
            {(Object.keys(PRIORITY_LABEL) as TaskPriority[]).map(p => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
          </select>
        </label>
        {task && (
          <label className="tf-field">Status
            <select className="input" value={status} onChange={e => setStatus(e.target.value as TaskStatus)}>
              {(Object.keys(STATUS_LABEL) as TaskStatus[]).map(s => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
            </select>
          </label>
        )}
        <label className="tf-field">Due date (optional)
          <input className="input" type="date" value={due} onChange={e => setDue(e.target.value)} />
        </label>
      </div>
      <div className="row-wrap">
        <button className="btn primary sm" type="submit" disabled={busy || title.trim().length < 2}>{busy ? 'Saving…' : submitLabel}</button>
        <button className="btn ghost sm" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
