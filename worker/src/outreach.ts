import type { Env } from './env';
import type { User } from './auth';
import { HttpError } from './http';

/**
 * Outreach analytics from the sequence tables the runner already keeps. No new
 * data is collected. Gmail confirms that it accepted a message, not that it
 * was delivered, so delivery is reported as unknown; bounces are the bounce
 * notices the runner saw in the thread. There is no open or click tracking.
 * Members see their own sequences; admins see everyone's (as on the
 * sequences page).
 */

const isAdmin = (u: User) => u.role === 'admin' || u.role === 'super_admin';
const RECIPIENT_STATES = ['pending', 'active', 'replied', 'opted_out', 'bounced', 'stopped', 'completed', 'failed'] as const;

export async function outreachStats(env: Env, user: User, p: URLSearchParams) {
  const to = Number(p.get('to')) || Date.now();
  const from = Number(p.get('from')) || to - 30 * 86_400_000;
  if (from > to) throw new HttpError(400, 'from must be before to');
  const mine = isAdmin(user) ? '' : ' AND s.owner_email = ?3';
  const args = (...a: unknown[]) => (isAdmin(user) ? a : [...a, user.memberEmail]);

  const seqs = (await env.DB.prepare(`SELECT s.id, s.name, s.owner_email, s.status, s.created_at, s.approved_at, s.approved_version, s.version FROM sequences s
    WHERE 1 = 1${mine.replace('?3', '?1')} ORDER BY s.created_at DESC LIMIT 500`).bind(...(isAdmin(user) ? [] : [user.memberEmail]))
    .all<{ id: number; name: string; owner_email: string; status: string; created_at: number; approved_at: number | null; approved_version: number | null; version: number }>()).results;
  const ids = new Set(seqs.map(s => s.id));

  const recips = (await env.DB.prepare('SELECT sequence_id, status, COUNT(*) AS n FROM sequence_enrollments GROUP BY sequence_id, status')
    .all<{ sequence_id: number; status: string; n: number }>()).results.filter(r => ids.has(r.sequence_id));
  // Sends in the period: each row is one step to one person.
  const sends = (await env.DB.prepare(`SELECT e.sequence_id, ss.status, COUNT(*) AS n FROM sequence_sends ss
    JOIN sequence_enrollments e ON e.id = ss.enrollment_id JOIN sequences s ON s.id = e.sequence_id
    WHERE ss.created_at >= ?1 AND ss.created_at <= ?2${mine} GROUP BY e.sequence_id, ss.status`).bind(...args(from, to))
    .all<{ sequence_id: number; status: 'sending' | 'sent' | 'failed'; n: number }>()).results;

  const sequences = seqs.map(s => {
    const byStatus = Object.fromEntries(RECIPIENT_STATES.map(k => [k, 0])) as Record<typeof RECIPIENT_STATES[number], number>;
    for (const r of recips) if (r.sequence_id === s.id && r.status in byStatus) byStatus[r.status as keyof typeof byStatus] = r.n;
    const sent = (k: string) => sends.filter(x => x.sequence_id === s.id && x.status === k).reduce((n, x) => n + x.n, 0);
    return {
      id: s.id, name: s.name, owner: s.owner_email, status: s.status, createdAt: s.created_at,
      awaitingApproval: s.status === 'draft',
      recipients: Object.values(byStatus).reduce((a, b) => a + b, 0),
      byStatus,
      // In the period:
      accepted: sent('sent'), failed: sent('failed'),
      // A send that started but never reported back: it may or may not have gone out.
      unconfirmed: sent('sending')
    };
  });
  const sum = (f: (s: typeof sequences[number]) => number) => sequences.reduce((n, s) => n + f(s), 0);
  return {
    from, to,
    scope: isAdmin(user) ? 'all' : 'mine',
    totals: {
      campaignsCreated: seqs.filter(s => s.created_at >= from && s.created_at <= to).length,
      awaitingApproval: sequences.filter(s => s.awaitingApproval).length,
      accepted: sum(s => s.accepted), failed: sum(s => s.failed), unconfirmed: sum(s => s.unconfirmed),
      replied: sum(s => s.byStatus.replied), bounced: sum(s => s.byStatus.bounced), optedOut: sum(s => s.byStatus.opted_out),
      recipientsFailed: sum(s => s.byStatus.failed)
    },
    delivery: 'unknown' as const,
    sequences
  };
}
