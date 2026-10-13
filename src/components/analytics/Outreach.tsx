import { useEffect, useMemo, useState } from 'react';
import type { ConversationStat } from '../../types';
import type { MailProvider } from '../../providers/types';
import { sample as readSample } from './useStats';
import { campaignOutcome, forgetCampaigns, loadCampaigns, type CampaignRecord } from '../../lib/campaignLog';
import { errorText } from '../Toast';
import { downloadCsv, toCsv } from './csv';

export interface OutreachStats {
  from: number; to: number;
  /** 'mine' for members; admins see everyone's sequences. */
  scope: 'mine' | 'all';
  /** Gmail reports acceptance, not delivery. */
  delivery: 'unknown';
  totals: { campaignsCreated: number; awaitingApproval: number; accepted: number; failed: number; unconfirmed: number; replied: number; bounced: number; optedOut: number; recipientsFailed: number };
  sequences: {
    id: number; name: string; owner: string; status: string; createdAt: number; awaitingApproval: boolean; recipients: number;
    byStatus: Record<'pending' | 'active' | 'replied' | 'opted_out' | 'bounced' | 'stopped' | 'completed' | 'failed', number>;
    accepted: number; failed: number; unconfirmed: number;
  }[];
}
export type OutreachLoader = (from: number, to: number) => Promise<OutreachStats>;

const day = (t: number) => new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

/** Bulk email went out from the signed-in mailbox (`provider`), so its outcomes are read there. */
export function Outreach({ load, from, to, provider, days }: { load?: OutreachLoader | null; from: number; to: number; provider: MailProvider; days: number }) {
  const [sample, setSample] = useState<ConversationStat[] | null>(null);
  useEffect(() => {
    let live = true;
    readSample(provider, days, false).then(r => live && setSample(r.conversations)).catch(() => live && setSample([]));
    return () => { live = false; };
  }, [provider, days]);
  const [seq, setSeq] = useState<OutreachStats | null>(null);
  const [err, setErr] = useState('');
  const [campaigns, setCampaigns] = useState<CampaignRecord[]>(loadCampaigns);

  useEffect(() => {
    if (!load) return;
    let live = true;
    setSeq(null); setErr('');
    load(from, to).then(r => live && setSeq(r)).catch(e => live && setErr(errorText(e)));
    return () => { live = false; };
  }, [load, from, to]);

  const runs = useMemo(() => campaigns.filter(c => c.at >= from && c.at <= to).map(c => ({ c, o: sample ? campaignOutcome(c, sample) : null })), [campaigns, from, to, sample]);

  const exportCsv = () => downloadCsv('outreach.csv', toCsv([
    ['Kind', 'Name', 'Owner / from', 'Created or sent', 'Status', 'Recipients', 'Accepted by Gmail', 'Failed', 'Unconfirmed', 'Held for approval', 'Replied', 'Bounce notices', 'Opted out', 'Delivery'],
    ...(seq?.sequences || []).map(s => ['Sequence', s.name, s.owner, day(s.createdAt), s.status, s.recipients, s.accepted, s.failed, s.unconfirmed, '', s.byStatus.replied, s.byStatus.bounced, s.byStatus.opted_out, 'unknown']),
    ...runs.map(({ c, o }) => ['Bulk email', c.subject, c.from, day(c.at), c.stopped ? 'stopped early' : 'done', c.total, c.accepted.length, c.failed, '', c.held, o?.replied ?? '', o?.bounceNotices ?? '', '', 'unknown'])
  ]));

  return (
    <>
      <div className="card panel">
        <div className="row-wrap" style={{ alignItems: 'center' }}>
          <span className="mono-label">Investor outreach sequences{seq ? (seq.scope === 'all' ? ' · everyone’s' : ' · yours') : ''}</span>
          <button className="btn sm ghost" style={{ marginLeft: 'auto' }} onClick={exportCsv} disabled={!seq && !runs.length}>Export CSV</button>
        </div>
        {!load && <span className="muted" style={{ fontSize: 12.5 }}>Sequences need the Axal VC Mail backend.</span>}
        {err && <span className="tone-danger" style={{ fontSize: 12.5 }}>{err}</span>}
        {load && !seq && !err && <div className="an-loading"><div className="spinner" /> Loading…</div>}
        {seq && (
          <>
            <div className="an-tiles">
              <Mini label="Campaigns created" value={seq.totals.campaignsCreated} note="in the period" />
              <Mini label="Awaiting approval" value={seq.totals.awaitingApproval} note="drafts, now" />
              <Mini label="Accepted by Gmail" value={seq.totals.accepted} note="messages, in the period" help="Gmail took the message for sending. This is not a delivery confirmation." />
              <Mini label="Failed" value={seq.totals.failed} note="Gmail refused, in the period" />
              <Mini label="Unconfirmed" value={seq.totals.unconfirmed} note="started, never reported back" help="The send started but the result never came back. Check Sent mail." />
              <Mini label="Replied" value={seq.totals.replied} note="recipients, current status" />
              <Mini label="Bounce notices" value={seq.totals.bounced} note="recipients, current status" help="A mailer-daemon or postmaster notice arrived in the thread." />
              <Mini label="Opted out" value={seq.totals.optedOut} note="recipients, current status" />
            </div>
            <span className="faint" style={{ fontSize: 11.5 }}>
              Delivery: unknown. Gmail confirms it accepted a message, not that it reached the inbox, so nothing here is counted as delivered.
              Recipient outcomes are their current status, whenever they happened.
            </span>
            {seq.sequences.length ? (
              <div className="table-scroll">
                <div className="trow outreach head"><span>SEQUENCE</span><span>STATUS</span><span>PEOPLE</span><span>ACCEPTED</span><span>FAILED</span><span>REPLIED</span><span>BOUNCED</span><span>OPTED OUT</span></div>
                {seq.sequences.map(s => (
                  <div key={s.id} className="trow outreach">
                    <span className="user-cell"><b>{s.name}</b><span>{s.owner} · {day(s.createdAt)}</span></span>
                    <span>{s.awaitingApproval ? <span className="pill warn">awaiting approval</span> : <span className="pill">{s.status}</span>}</span>
                    <span className="mono">{s.recipients}</span><span className="mono">{s.accepted}</span>
                    <span className="mono">{s.failed + s.byStatus.failed ? s.failed + ' / ' + s.byStatus.failed + ' people' : 0}</span>
                    <span className="mono">{s.byStatus.replied}</span><span className="mono">{s.byStatus.bounced}</span><span className="mono">{s.byStatus.opted_out}</span>
                  </div>
                ))}
              </div>
            ) : <span className="faint" style={{ fontSize: 12.5 }}>No sequences yet.</span>}
          </>
        )}
      </div>

      <div className="card panel">
        <div className="row-wrap" style={{ alignItems: 'center' }}>
          <span className="mono-label">Bulk email</span>
          {!!campaigns.length && <button className="btn sm ghost" style={{ marginLeft: 'auto' }} onClick={() => { forgetCampaigns(); setCampaigns([]); }}>Forget this log</button>}
        </div>
        <span className="muted" style={{ fontSize: 12.5 }}>
          Runs sent from this browser, kept on this device only (counts and Gmail thread ids, no text). Replies and bounce notices come from the conversations read for the period.
        </span>
        {!runs.length ? <span className="faint" style={{ fontSize: 12.5 }}>No bulk email sent from this browser in the period.</span> : (
          <div className="table-scroll">
            <div className="trow outreach head"><span>SUBJECT</span><span>SENT</span><span>TRIED</span><span>ACCEPTED</span><span>FAILED</span><span>REPLIED</span><span>BOUNCED</span><span>NO REPLY SEEN</span></div>
            {runs.map(({ c, o }) => (
              <div key={c.id} className="trow outreach">
                <span className="user-cell"><b>{c.subject || '(no subject)'}</b><span>{c.from}{c.held ? ' · ' + c.held + ' held for approval' : ''}{c.stopped ? ' · stopped early' : ''}</span></span>
                <span className="muted">{day(c.at)}</span>
                <span className="mono">{c.total}</span><span className="mono">{c.accepted.length}</span><span className="mono">{c.failed}</span>
                <span className="mono">{o ? o.replied : '…'}</span><span className="mono">{o ? o.bounceNotices : '…'}</span>
                <span className="mono" title={o?.notInSample ? o.notInSample + ' not in the conversations read for this period' : undefined}>{o ? o.noReplySeen + (o.notInSample ? ' (+' + o.notInSample + ' unknown)' : '') : '…'}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card panel an-limits">
        <span className="mono-label">Not measured</span>
        <span className="muted">Opens and link clicks aren’t tracked. Measuring them needs tracking pixels or tracked links, which are unreliable (privacy proxies and security scanners trigger them) and need recipients’ consent, so they are left out for investor correspondence. Inbox placement isn’t visible from a mailbox either.</span>
      </div>
    </>
  );
}

function Mini({ label, value, note, help }: { label: string; value: number; note: string; help?: string }) {
  return (
    <div className="card an-tile" title={help}>
      <span className="an-tile-label">{label}{help && <span className="faint" aria-hidden> ⓘ</span>}</span>
      <b className="an-tile-value">{value}</b>
      <span className="an-tile-note">{note}</span>
      {help && <span className="sr-only">{help}</span>}
    </div>
  );
}
