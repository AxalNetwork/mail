import { useState } from 'react';

export interface Bar { key: string | number; label: string; value: number; tip: string }

/**
 * Single-series column chart: thin columns with rounded tops on one baseline,
 * recessive gridlines, a hover tooltip per column, sparse axis labels.
 */
export function Columns({ bars, height = 140, labelEvery, ariaLabel }: { bars: Bar[]; height?: number; labelEvery?: number; ariaLabel: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...bars.map(b => b.value));
  const step = niceStep(max);
  const top = Math.ceil(max / step) * step;
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
  const W = 100 / Math.max(1, bars.length);
  const every = labelEvery || Math.max(1, Math.ceil(bars.length / 7));
  return (
    <div className="cols" style={{ height: height + 24 }} role="img" aria-label={ariaLabel}
      onMouseLeave={() => setHover(null)}>
      <div className="cols-grid" style={{ height }}>
        {ticks.map(t => (
          <div key={t} className="cols-tick" style={{ bottom: (t / top) * 100 + '%' }}><span>{compact(t)}</span></div>
        ))}
      </div>
      <div className="cols-plot" style={{ height }}>
        {bars.map((b, i) => (
          <div key={b.key} className="cols-slot" style={{ width: W + '%' }} onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} tabIndex={0} aria-label={b.tip}>
            <div className={'cols-bar' + (hover === i ? ' on' : '')} style={{ height: b.value ? Math.max(2, (b.value / top) * 100) + '%' : 0 }} />
          </div>
        ))}
        {hover != null && (
          <div className="cols-tip" style={{ left: Math.min(88, Math.max(12, (hover + 0.5) * W)) + '%' }}>{bars[hover].tip}</div>
        )}
      </div>
      <div className="cols-x">
        {bars.map((b, i) => <span key={b.key} style={{ width: W + '%' }}>{i % every === 0 ? b.label : ''}</span>)}
      </div>
    </div>
  );
}

function niceStep(max: number): number {
  const raw = max / 4;
  const p = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  const n = raw / p;
  return Math.max(1, (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p);
}

export function compact(n: number): string {
  return n >= 1000 ? (n / 1000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, '') + 'K' : String(n);
}
