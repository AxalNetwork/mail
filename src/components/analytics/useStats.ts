import { useEffect, useState } from 'react';
import type { MailProvider } from '../../providers/types';
import type { ConversationSample } from '../../types';
import { computeStats, type MailboxStats } from '../../lib/analytics';

// One sample per provider and period, reused for five minutes across pages.
const cache = new WeakMap<MailProvider, Map<number, { at: number; p: Promise<ConversationSample> }>>();
const TTL = 5 * 60_000;

function sample(provider: MailProvider, days: number, fresh: boolean): Promise<ConversationSample> {
  let m = cache.get(provider);
  if (!m) cache.set(provider, (m = new Map()));
  const hit = m.get(days);
  if (hit && !fresh && Date.now() - hit.at < TTL) return hit.p;
  const p = provider.conversations(days, days > 30 ? 500 : 300);
  m.set(days, { at: Date.now(), p });
  p.catch(() => m!.delete(days));
  return p;
}

export interface StatsState {
  stats: MailboxStats | null;
  truncated: boolean;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export function useStats(provider: MailProvider, days: number, orgDomain: string): StatsState {
  const [state, setState] = useState<Omit<StatsState, 'reload'>>({ stats: null, truncated: false, loading: true, error: null });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let live = true;
    setState(s => ({ ...s, loading: true, error: null }));
    sample(provider, days, nonce > 0)
      .then(r => live && setState({ stats: computeStats(r.conversations, { now: Date.now(), days, orgDomain }), truncated: r.truncated, loading: false, error: null }))
      .catch(e => live && setState(s => ({ ...s, loading: false, error: e instanceof Error ? e.message : String(e) })));
    return () => { live = false; };
  }, [provider, days, orgDomain, nonce]);
  return { ...state, reload: () => setNonce(n => n + 1) };
}

/** The raw conversation sample (metadata only), shared with Analytics through the same cache. */
export function useSample(provider: MailProvider, days: number): { sample: ConversationSample | null; error: string | null; loading: boolean } {
  const [state, setState] = useState<{ sample: ConversationSample | null; error: string | null; loading: boolean }>({ sample: null, error: null, loading: true });
  useEffect(() => {
    let live = true;
    sample(provider, days, false)
      .then(r => live && setState({ sample: r, error: null, loading: false }))
      .catch(e => live && setState({ sample: null, error: e instanceof Error ? e.message : String(e), loading: false }));
    return () => { live = false; };
  }, [provider, days]);
  return state;
}
