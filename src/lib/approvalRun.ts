import type { Identity, OutgoingMessage, Profile } from '../types';
import type { MailProvider } from '../providers/types';
import type { Approval, ApprovalCampaign, ApprovalMessage, TasksApi } from './tasksApi';
import { OPTOUT_LINE } from './bulk';
import { textToHtml } from './html';
import { assembleHtml, assembleText } from './outgoing';
import { signatureHtml, signatureText } from './signature';

/** The part of a composed message an approval covers (attachments and scheduling aren't supported). */
export function toApprovalMessage(m: OutgoingMessage): ApprovalMessage {
  return {
    identity: { id: m.identity.id, addr: m.identity.addr, name: m.identity.name },
    to: m.to.map(p => ({ name: p.name, email: p.email, org: p.org })),
    cc: m.cc.map(p => ({ name: p.name, email: p.email, org: p.org })),
    bcc: m.bcc.map(p => ({ name: p.name, email: p.email, org: p.org })),
    subject: m.subject, html: m.html, text: m.text, priority: m.priority,
    reply: m.reply ? { threadId: m.reply.threadId, messageIdHeader: m.reply.messageIdHeader || '', references: m.reply.references || '', rootId: m.reply.rootId || '' } : null
  };
}

function identityFor(identities: Identity[], addr: string): Identity {
  const id = identities.find(i => i.addr.toLowerCase() === addr.toLowerCase());
  if (!id) throw new Error('Send this from ' + addr + ': open that mailbox in Axal VC Mail first.');
  return id;
}

export function fromApprovalMessage(p: ApprovalMessage, identities: Identity[]): OutgoingMessage {
  return {
    identity: identityFor(identities, p.identity.addr),
    to: p.to, cc: p.cc, bcc: p.bcc, subject: p.subject, html: p.html, text: p.text, attachments: [], priority: p.priority,
    reply: p.reply ? { threadId: p.reply.threadId, messageIdHeader: p.reply.messageIdHeader || undefined, references: p.reply.references || undefined, rootId: p.reply.rootId || undefined } : undefined
  };
}

export const isCampaign = (p: ApprovalMessage | ApprovalCampaign): p is ApprovalCampaign => Array.isArray((p as ApprovalCampaign).messages);

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Send an approved request. The server hands out the payload once, and only
 * while the approval covers the current content; what is sent is that payload,
 * never what is on screen. The outcome is recorded either way, so a failed or
 * partial send is never retried automatically.
 */
export async function runApproval(api: TasksApi, a: Approval, provider: MailProvider, profile: Profile,
  onProgress?: (done: number, total: number) => void): Promise<{ approval: Approval; sent: number; failed: string[] }> {
  const identities = await provider.identities();
  // Check the From before claiming, so a wrong mailbox doesn't use up the approval.
  identityFor(identities, a.payload.identity.addr);
  const { payload } = await api.claim(a);
  const failed: string[] = [];
  let sent = 0;
  if (isCampaign(payload)) {
    const identity = identityFor(identities, payload.identity.addr);
    const footer = payload.optout ? OPTOUT_LINE : undefined;
    const sigHtml = signatureHtml(profile);
    const sigText = signatureText(profile);
    for (let i = 0; i < payload.messages.length; i++) {
      const m = payload.messages[i];
      try {
        await provider.send({
          identity, to: [m.to], cc: [], bcc: [], subject: m.subject, attachments: [], priority: 'Normal',
          html: assembleHtml(textToHtml(m.text), sigHtml, null, footer), text: assembleText(m.text, sigText, null, footer)
        });
        sent++;
      } catch (e) {
        failed.push(m.to.email + ': ' + (e instanceof Error ? e.message : String(e)));
      }
      onProgress?.(i + 1, payload.messages.length);
      if (provider.capabilities.bulkSpacingMs && i < payload.messages.length - 1) await sleep(provider.capabilities.bulkSpacingMs);
    }
  } else {
    onProgress?.(0, 1);
    try {
      // A shared-mailbox warning (a newer reply) was already weighed by the approver.
      await provider.send({ ...fromApprovalMessage(payload, identities), confirmShared: a.kind === 'shared_reply' });
      sent = 1;
    } catch (e) {
      failed.push(e instanceof Error ? e.message : String(e));
    }
    onProgress?.(1, 1);
  }
  const detail = (sent ? sent + ' sent' : 'Nothing sent') + (failed.length ? '; ' + failed.length + ' failed: ' + failed.slice(0, 20).join('; ') : '');
  const approval = await api.finish(a.id, failed.length === 0, detail);
  return { approval, sent, failed };
}
