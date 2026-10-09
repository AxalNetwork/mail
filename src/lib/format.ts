export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map(w => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

export function formatSize(bytes: number): string {
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + ' MB';
  return Math.max(1, Math.round(bytes / 1e3)) + ' KB';
}

export function fileExt(name: string): string {
  const dot = name.lastIndexOf('.');
  return (dot > 0 ? name.slice(dot + 1) : 'FILE').toUpperCase().slice(0, 4);
}

export function clockTime(d = new Date()): string {
  return d.toTimeString().slice(0, 5);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** List-row time: "09:42", "Yesterday", "Tue", "5 Oct" or "5 Oct 2024". */
export function listTime(ms: number, now = new Date()): string {
  const d = new Date(ms);
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 864e5);
  if (days <= 0) return clockTime(d);
  if (days === 1) return 'Yesterday';
  if (days < 7) return DAYS[d.getDay()];
  const base = d.getDate() + ' ' + MONTHS[d.getMonth()];
  return d.getFullYear() === now.getFullYear() ? base : base + ' ' + d.getFullYear();
}

/** Message header time: "Today 09:42", "Yesterday 16:20", "Tue 11:05", "5 Oct 10:14". */
export function messageTime(ms: number, now = new Date()): string {
  const d = new Date(ms);
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 864e5);
  const t = clockTime(d);
  if (days <= 0) return 'Today ' + t;
  return listTime(ms, now) + ' ' + t;
}

export function plural(n: number, word: string, many = word + 's'): string {
  return n + ' ' + (n === 1 ? word : many);
}
