import type { Profile } from '../types';
import { escapeHtml as e } from './html';

export const ORG_NAME = 'Axal VC';
export const ORG_URL = 'https://axal.vc';

export function profileName(p: Profile): string {
  return [p.first, p.last].filter(Boolean).join(' ');
}

export function missingFields(p: Profile): string[] {
  return [!p.photo && 'photo', !p.region && 'region', !p.whatsapp && 'WhatsApp', !p.linkedin && 'LinkedIn'].filter(Boolean) as string[];
}

const MONO = "'Roboto Mono',Menlo,Consolas,monospace";
const SANS = "'Space Grotesk',Arial,Helvetica,sans-serif";

/**
 * The standard signature as email-safe HTML (tables + inline styles, so it
 * renders the same in Gmail, Outlook and Apple Mail). The composer preview,
 * outgoing mail and the Gmail signature setting all use this one function.
 * Lines whose profile field is empty are left out.
 */
export function signatureHtml(p: Profile): string {
  const name = profileName(p);
  const ini = ((p.first || ' ')[0] + (p.last || ' ')[0]).trim().toUpperCase();
  const digits = (p.whatsapp || '').replace(/\D/g, '');
  const li = p.linkedin || '';
  const liHref = /^https?:/i.test(li) ? li : 'https://' + li;
  const tag = (label: string, color: string) =>
    `<span style="font-family:${MONO};font-size:9.5px;letter-spacing:.07em;color:${color}">${label}</span>`;

  const avatar = p.photoUrl
    ? `<img src="${e(p.photoUrl)}" alt="${e(name)}" width="60" height="60" style="display:block;width:60px;height:60px;border-radius:50%;object-fit:cover">`
    : `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="60" height="60" align="center" valign="middle" style="width:60px;height:60px;border-radius:50%;background:#f4f0fe;border:1px solid #ddd0fb;color:#6d28d9;font-family:${SANS};font-weight:700;font-size:19px">${e(ini)}</td></tr></table>`;

  const link = 'text-decoration:none;white-space:nowrap;display:inline-block;margin-right:14px';
  const links: string[] = [`<a href="mailto:${e(p.email)}" style="color:#6d28d9;${link}">${e(p.email)}</a>`];
  if (digits) links.push(`<a href="https://wa.me/${digits}" style="color:#18181b;${link}">${tag('WHATSAPP', '#047857')}&nbsp;${e(p.whatsapp)}</a>`);
  if (li) links.push(`<a href="${e(liHref)}" style="color:#18181b;${link}">${tag('LINKEDIN', '#6d28d9')}&nbsp;${e(li)}</a>`);

  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid #ececf1;font-family:${SANS};color:#18181b;width:100%;max-width:560px">` +
    `<tr>` +
    `<td valign="middle" width="74" style="width:74px;min-width:74px;padding:14px 14px 4px 0">${avatar}</td>` +
    `<td valign="middle" style="padding:14px 14px 4px 0">` +
    `<div style="font-size:15px;font-weight:700;letter-spacing:-0.01em">${e(name)}</div>` +
    `<div style="font-size:12.5px;color:#6b6577;padding-top:2px">${e(p.title)} · ${ORG_NAME}</div>` +
    (p.region ? `<div style="font-size:12px;padding-top:2px">${tag('REGION', '#a1a1aa')}&nbsp;${e(p.region)}</div>` : '') +
    `<div style="font-size:12px;padding-top:6px">${links.join(' ')}</div>` +
    `</td>` +
    `<td valign="middle" align="center" width="70" style="width:70px;min-width:70px;padding:14px 0 4px 14px;border-left:1px solid #ececf1">` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="24" height="24" align="center" valign="middle" style="width:24px;height:24px;border-radius:6px;background:#7c3aed;color:#ffffff;font-family:${SANS};font-weight:700;font-size:13px">A</td></tr></table>` +
    `<a href="${ORG_URL}" style="display:block;padding-top:4px;font-family:${MONO};font-size:10px;color:#6b6577;text-decoration:none">axal.vc</a>` +
    `</td>` +
    `</tr></table>`
  );
}

/** Plain-text signature for the text/plain part of outgoing mail. */
export function signatureText(p: Profile): string {
  return [
    profileName(p),
    [p.title, ORG_NAME].filter(Boolean).join(' · '),
    p.region && 'Region: ' + p.region,
    p.email,
    p.whatsapp && 'WhatsApp: ' + p.whatsapp,
    p.linkedin && 'LinkedIn: ' + p.linkedin,
    ORG_URL.replace(/^https:\/\//, '')
  ].filter(Boolean).join('\n');
}
