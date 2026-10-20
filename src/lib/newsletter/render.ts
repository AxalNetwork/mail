import type { Block, Brand, IssueContent, Item, Recipient, Rendered, Sender, SystemEmailId, TemplateId } from './types';

/**
 * Email HTML for newsletters: 600px single column, tables and inline styles
 * (a <style> block only for phones and dark mode), bulletproof buttons, a
 * hidden preheader, and a plain-text twin. Pure functions with no DOM, so the
 * Worker renders each recipient's copy with the same code the editor previews.
 *
 * Everything the author typed is escaped first; the small markup is applied
 * to the escaped text, and links accept only https, mailto and the personal
 * link tokens.
 */

const SANS = "'Space Grotesk',system-ui,-apple-system,'Segoe UI',Arial,sans-serif";
const MONO = "'Roboto Mono',ui-monospace,'Courier New',monospace";
const C = { text: '#18181b', muted: '#6b6577', faint: '#9b96a6', page: '#f4f3f7', card: '#ffffff', line: '#ececf1', accent: '#7c3aed', strong: '#6d28d9', soft: '#f4f0fe', softLine: '#ddd0fb' };

export const TEMPLATE_NAME: Record<TemplateId, string> = {
  brief: 'The Axal VC Brief', letter: 'Partner Letter', spotlight: 'Portfolio Spotlight', founder: 'Founder call',
  event_invite: 'Event invitation', event_recap: 'Event recap', insights: 'Insights', announcement: 'Announcement'
};

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const URL_TOKENS = ['{unsubscribe_url}', '{preferences_url}', '{view_in_browser_url}'];

/** A link target the email may carry, or '' (the link is dropped). */
export function safeUrl(u: string): string {
  const t = (u || '').trim();
  if (URL_TOKENS.includes(t)) return t;
  if (/^https:\/\/[^\s"'<>]+$/i.test(t) || /^mailto:[^\s"'<>]+$/i.test(t)) return t;
  return '';
}

// ---------- inline markup ----------

function inline(escaped: string): string {
  return escaped
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, href: string) => {
      const u = safeUrl(href.replace(/&amp;/g, '&'));
      return u ? `<a href="${esc(u)}" style="color:${C.strong};text-decoration:underline" class="link">${label}</a>` : label;
    })
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\n/g, '<br>');
}

const P = `margin:0 0 14px;font-family:${SANS};font-size:16px;line-height:1.6;color:${C.text}`;

/** Paragraphs, lists and (when allowed) headings from typed text. */
export function markup(text: string, headings = false): string {
  const blocks = esc(text.replace(/\r\n?/g, '\n').trim()).split(/\n{2,}/);
  return blocks.map(b => {
    const lines = b.split('\n');
    if (lines.every(l => /^[-•] /.test(l))) {
      return `<ul style="margin:0 0 14px;padding-left:22px;font-family:${SANS};font-size:16px;line-height:1.6;color:${C.text}" class="text">` +
        lines.map(l => `<li style="margin:0 0 6px">${inline(l.replace(/^[-•] /, ''))}</li>`).join('') + '</ul>';
    }
    if (lines.every(l => /^\d+[.)] /.test(l))) {
      return `<ol style="margin:0 0 14px;padding-left:22px;font-family:${SANS};font-size:16px;line-height:1.6;color:${C.text}" class="text">` +
        lines.map(l => `<li style="margin:0 0 6px">${inline(l.replace(/^\d+[.)] /, ''))}</li>`).join('') + '</ol>';
    }
    if (headings && /^### /.test(b)) return `<h3 style="margin:22px 0 8px;font-family:${SANS};font-size:18px;line-height:1.35;color:${C.text}" class="text">${inline(b.slice(4))}</h3>`;
    if (headings && /^## /.test(b)) return `<h2 style="margin:26px 0 10px;font-family:${SANS};font-size:22px;line-height:1.3;letter-spacing:-0.01em;color:${C.text}" class="text">${inline(b.slice(3))}</h2>`;
    return `<p style="${P}" class="text">${inline(b)}</p>`;
  }).join('');
}

/** Plain-text version of typed text: links as "label (url)". */
export function plain(text: string): string {
  return text.replace(/\r\n?/g, '\n').trim()
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, l: string, u: string) => (safeUrl(u) ? `${l} (${u})` : l))
    .replace(/\*\*([^*]+)\*\*/g, '$1').replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2')
    .replace(/^#{2,3} /gm, '');
}

// ---------- pieces ----------

const label = (t: string) => t ? `<div style="margin:0 0 12px;font-family:${MONO};font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:${C.muted}" class="muted">${esc(t)}</div>` : '';

export function button(text: string, href: string): string {
  const u = safeUrl(href);
  if (!u || !text.trim()) return '';
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 18px"><tr><td bgcolor="${C.accent}" style="border-radius:10px;background:${C.accent}" class="btn">` +
    `<a href="${esc(u)}" style="display:inline-block;padding:13px 22px;font-family:${SANS};font-size:15px;font-weight:600;line-height:1.2;color:#ffffff;text-decoration:none;border-radius:10px;mso-padding-alt:0">${esc(text)}</a>` +
    '</td></tr></table>';
}

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]!.toUpperCase()).join('') || 'AX';

function avatar(name: string, title: string): string {
  if (!name.trim()) return '';
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 6px"><tr>` +
    `<td width="44" height="44" align="center" valign="middle" style="width:44px;height:44px;border-radius:50%;background:${C.soft};border:1px solid ${C.softLine};font-family:${SANS};font-weight:700;font-size:15px;color:${C.strong}" class="soft">${esc(initials(name))}</td>` +
    `<td style="padding-left:12px;font-family:${SANS};font-size:14px;line-height:1.4;color:${C.text}" class="text"><strong>${esc(name)}</strong>${title ? `<br><span style="color:${C.muted}" class="muted">${esc(title)}</span>` : ''}</td>` +
    '</tr></table>';
}

const section = (inner: string) => inner ? `<tr><td style="padding:0 32px 26px" class="px">${inner}</td></tr>` : '';
const rule = `<tr><td style="padding:0 32px 26px" class="px"><div style="height:1px;line-height:1px;background:${C.line};font-size:0" class="line">&nbsp;</div></td></tr>`;

function itemRows(items: Item[], style: 'list' | 'rows'): string {
  return items.filter(i => i.title.trim()).map((i, n) => {
    const u = safeUrl(i.url);
    const title = u ? `<a href="${esc(u)}" style="color:${C.text};text-decoration:none" class="text"><strong>${esc(i.title)}</strong></a>` : `<strong>${esc(i.title)}</strong>`;
    const meta = i.meta ? `<span style="font-family:${MONO};font-size:11px;letter-spacing:.06em;color:${C.muted}" class="muted">${esc(i.meta)}</span>` : '';
    const border = n ? `border-top:1px solid ${C.line};` : '';
    if (style === 'rows') {
      return `<tr><td style="${border}padding:11px 0;font-family:${SANS};font-size:15px;line-height:1.45;color:${C.text}" class="text line-top">${title}${i.text ? ` <span style="color:${C.muted}" class="muted">· ${esc(i.text)}</span>` : ''}</td>` +
        `<td align="right" style="${border}padding:11px 0 11px 12px;white-space:nowrap" class="line-top">${meta}</td></tr>`;
    }
    return `<tr><td style="${border}padding:12px 0;font-family:${SANS};font-size:15px;line-height:1.5;color:${C.text}" class="text line-top">${title}${meta ? '&nbsp; ' + meta : ''}` +
      (i.text ? `<div style="margin-top:3px;color:${C.muted};font-size:14.5px" class="muted">${inline(esc(i.text))}</div>` : '') + '</td></tr>';
  }).join('');
}

function eventRows(items: Item[]): string {
  return items.filter(i => i.title.trim()).map((i, n) => {
    const u = safeUrl(i.url);
    const [a, ...b] = (i.meta || '').split(' ');
    return `<tr><td width="64" valign="top" style="${n ? `border-top:1px solid ${C.line};` : ''}padding:14px 0" class="line-top">` +
      `<div style="width:56px;border-radius:10px;background:${C.soft};border:1px solid ${C.softLine};text-align:center;padding:8px 0;font-family:${MONO};color:${C.strong}" class="soft">` +
      `<div style="font-size:10px;letter-spacing:.1em">${esc((a || '').toUpperCase())}</div><div style="font-size:17px;font-weight:500;margin-top:2px">${esc(b.join(' '))}</div></div></td>` +
      `<td valign="top" style="${n ? `border-top:1px solid ${C.line};` : ''}padding:14px 0 14px 14px;font-family:${SANS};font-size:15px;line-height:1.5;color:${C.text}" class="text line-top">` +
      (u ? `<a href="${esc(u)}" style="color:${C.text};text-decoration:none" class="text"><strong>${esc(i.title)}</strong></a>` : `<strong>${esc(i.title)}</strong>`) +
      (i.text ? `<div style="color:${C.muted};font-size:14.5px" class="muted">${esc(i.text)}</div>` : '') + '</td></tr>';
  }).join('');
}

const table = (rows: string) => rows ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table>` : '';

function blockHtml(b: Block, t: TemplateId): string {
  switch (b.type) {
    case 'hero':
      return section(label(b.kicker) +
        (b.title ? `<h1 style="margin:0 0 12px;font-family:${SANS};font-size:28px;line-height:1.2;letter-spacing:-0.02em;font-weight:700;color:${C.text}" class="text h1">${esc(b.title)}</h1>` : '') +
        (b.text ? markup(b.text) : ''));
    case 'note':
      return section(label(b.label) + markup(b.text, t === 'letter') + avatar(b.name, b.title));
    case 'essay': {
      const u = safeUrl(b.url);
      return section(label(b.label) +
        `<h2 style="margin:0 0 8px;font-family:${SANS};font-size:22px;line-height:1.3;letter-spacing:-0.01em;color:${C.text}" class="text">${u ? `<a href="${esc(u)}" style="color:${C.text};text-decoration:none" class="text">${esc(b.title)}</a>` : esc(b.title)}</h2>` +
        (b.text ? `<p style="${P};color:${C.muted}" class="muted">${inline(esc(b.text))}</p>` : '') +
        (b.meta ? `<div style="margin:0 0 14px;font-family:${MONO};font-size:11px;letter-spacing:.08em;color:${C.muted}" class="muted">${esc(b.meta)}</div>` : '') +
        button('Read on axal.vc', b.url));
    }
    case 'items': {
      const rows = itemRows(b.items, /role/i.test(b.label) ? 'rows' : 'list');
      const more = safeUrl(b.footerUrl) && b.footerLabel ? `<p style="margin:12px 0 0;font-family:${SANS};font-size:14px"><a href="${esc(safeUrl(b.footerUrl))}" style="color:${C.strong};font-weight:600;text-decoration:none" class="link">${esc(b.footerLabel)} →</a></p>` : '';
      return rows ? section(label(b.label) + table(rows) + more) : '';
    }
    case 'events': {
      const rows = eventRows(b.items);
      return rows ? section(label(b.label) + table(rows)) : '';
    }
    case 'text':
      return section(label(b.label) +
        (b.heading ? `<h2 style="margin:0 0 10px;font-family:${SANS};font-size:20px;line-height:1.3;color:${C.text}" class="text">${esc(b.heading)}</h2>` : '') +
        markup(b.text, t === 'insights' || t === 'letter'));
    case 'quote':
      return b.text.trim() ? section(`<div style="border-left:3px solid ${C.accent};padding:4px 0 4px 18px">` +
        `<p style="margin:0 0 8px;font-family:${SANS};font-size:19px;line-height:1.45;font-style:italic;color:${C.text}" class="text">“${esc(b.text)}”</p>` +
        (b.attribution ? `<div style="font-family:${MONO};font-size:11px;letter-spacing:.08em;color:${C.muted}" class="muted">${esc(b.attribution)}</div>` : '') + '</div>') : '';
    case 'image': {
      const src = safeUrl(b.src);
      if (!src || !src.startsWith('https://')) return '';
      const img = `<img src="${esc(src)}" width="536" alt="${esc(b.alt)}" style="display:block;width:100%;max-width:536px;height:auto;border:0;border-radius:10px">`;
      const u = safeUrl(b.url);
      return section((u ? `<a href="${esc(u)}">${img}</a>` : img) +
        (b.caption ? `<div style="margin-top:8px;font-family:${SANS};font-size:13px;color:${C.muted}" class="muted">${esc(b.caption)}</div>` : ''));
    }
    case 'button': {
      const second = safeUrl(b.secondaryUrl) && b.secondaryLabel ? `<p style="margin:0;font-family:${SANS};font-size:14px"><a href="${esc(safeUrl(b.secondaryUrl))}" style="color:${C.strong};font-weight:600;text-decoration:none" class="link">${esc(b.secondaryLabel)}</a></p>` : '';
      const main = button(b.label, b.url);
      return main || second ? section(main + second) : '';
    }
    case 'callout':
      return b.value.trim() ? section(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:${C.soft};border:1px solid ${C.softLine};border-radius:12px;padding:18px 20px" class="soft">` +
        `<div style="font-family:${SANS};font-size:30px;font-weight:700;letter-spacing:-0.02em;color:${C.strong}" class="strong">${esc(b.value)}</div>` +
        (b.text ? `<div style="margin-top:4px;font-family:${SANS};font-size:15px;line-height:1.5;color:${C.text}" class="text">${esc(b.text)}</div>` : '') +
        (b.source ? `<div style="margin-top:8px;font-family:${MONO};font-size:10.5px;letter-spacing:.06em;color:${C.muted}" class="muted">SOURCE · ${esc(b.source)}</div>` : '') +
        '</td></tr></table>') : '';
    case 'tags':
      return b.tags.filter(Boolean).length ? section(b.tags.filter(Boolean).map(x =>
        `<span style="display:inline-block;margin:0 6px 6px 0;padding:4px 10px;border-radius:999px;border:1px solid ${C.softLine};background:${C.soft};font-family:${MONO};font-size:11px;letter-spacing:.08em;color:${C.strong}" class="soft">${esc(x.toUpperCase())}</span>`).join('')) : '';
    case 'divider':
      return rule;
  }
}

function blockText(b: Block): string {
  const h = (s: string) => (s ? s.toUpperCase() + '\n' : '');
  switch (b.type) {
    case 'hero': return h(b.kicker) + (b.title ? b.title + '\n\n' : '') + plain(b.text);
    case 'note': return h(b.label) + plain(b.text) + (b.name ? `\n\n— ${b.name}${b.title ? ', ' + b.title : ''}` : '');
    case 'essay': return h(b.label) + b.title + '\n' + b.text + (b.meta ? '\n' + b.meta : '') + (safeUrl(b.url) ? '\nRead on axal.vc: ' + b.url : '');
    case 'items': return h(b.label) + b.items.filter(i => i.title).map(i => `- ${i.title}${i.meta ? ' (' + i.meta + ')' : ''}${i.text ? ': ' + i.text : ''}${safeUrl(i.url) ? '\n  ' + i.url : ''}`).join('\n') + (safeUrl(b.footerUrl) && b.footerLabel ? `\n${b.footerLabel}: ${b.footerUrl}` : '');
    case 'events': return h(b.label) + b.items.filter(i => i.title).map(i => `- ${i.meta}: ${i.title}${i.text ? ', ' + i.text : ''}${safeUrl(i.url) ? '\n  ' + i.url : ''}`).join('\n');
    case 'text': return h(b.label) + (b.heading ? b.heading + '\n\n' : '') + plain(b.text);
    case 'quote': return b.text ? `"${b.text}"${b.attribution ? '\n— ' + b.attribution : ''}` : '';
    case 'image': return b.alt ? `[Image: ${b.alt}]` : '';
    case 'button': return [safeUrl(b.url) && b.label ? `${b.label}: ${b.url}` : '', safeUrl(b.secondaryUrl) && b.secondaryLabel ? `${b.secondaryLabel}: ${b.secondaryUrl}` : ''].filter(Boolean).join('\n');
    case 'callout': return b.value ? `${b.value} — ${b.text}${b.source ? ' (Source: ' + b.source + ')' : ''}` : '';
    case 'tags': return b.tags.filter(Boolean).join(' · ');
    case 'divider': return '———';
  }
}

// ---------- the page ----------

const STYLE = `
body{margin:0!important;padding:0!important;width:100%!important;-webkit-text-size-adjust:100%}
a{color:${C.strong}}
@media only screen and (max-width:620px){
  .container{width:100%!important}
  .px{padding-left:20px!important;padding-right:20px!important}
  .h1{font-size:24px!important}
}
@media (prefers-color-scheme:dark){
  .bg-page{background:#121116!important}
  .bg-card{background:#1c1b22!important;border-color:#2c2a35!important}
  .text,.text strong,.text a{color:#f2f1f5!important}
  .muted{color:#a7a2b3!important}
  .line{background:#2c2a35!important}
  .line-top{border-color:#2c2a35!important}
  .soft{background:#2a2142!important;border-color:#4b3a7a!important;color:#d9c8ff!important}
  .strong,.link{color:#c4b5fd!important}
  .notice{background:#2a2410!important;border-color:#6b5a1d!important;color:#f3e3a8!important}
}
[data-ogsc] .bg-page{background:#121116!important}
[data-ogsc] .bg-card{background:#1c1b22!important}
[data-ogsc] .text{color:#f2f1f5!important}
[data-ogsc] .muted{color:#a7a2b3!important}`;

interface PageParts {
  subject: string; preheader: string; headerLeft: string; headerRight: string;
  banner: string; body: string; footer: string;
}

function page(p: PageParts): string {
  const pre = p.preheader ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${C.page};opacity:0">${esc(p.preheader)}${'&#8204;&nbsp;'.repeat(40)}</div>` : '';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${esc(p.subject)}</title>` +
    `<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;600;700&family=Roboto+Mono:wght@400;500&display=swap" rel="stylesheet"><style>${STYLE}</style></head>` +
    `<body style="margin:0;padding:0;background:${C.page}" class="bg-page">${pre}` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.page}" class="bg-page"><tr><td align="center" style="padding:24px 12px">` +
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px" class="container">` +
    `<tr><td style="padding:0 8px 16px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>` +
    `<td style="font-family:${SANS};font-size:17px;font-weight:700;letter-spacing:-0.02em;color:${C.text}" class="text">${p.headerLeft}</td>` +
    `<td align="right" style="font-family:${MONO};font-size:10.5px;letter-spacing:.1em;color:${C.muted}" class="muted">${p.headerRight}</td></tr></table></td></tr>` +
    p.banner +
    `<tr><td style="background:${C.card};border:1px solid ${C.line};border-radius:14px" class="bg-card"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">` +
    `<tr><td style="height:30px;line-height:30px;font-size:0">&nbsp;</td></tr>${p.body}<tr><td style="height:6px;line-height:6px;font-size:0">&nbsp;</td></tr></table></td></tr>` +
    p.footer +
    '</table></td></tr></table></body></html>';
}

function footerLinks(links: [string, string][]): string {
  return links.filter(([, u]) => u).map(([l, u]) => `<a href="${esc(u)}" style="color:${C.muted};text-decoration:underline" class="muted">${esc(l)}</a>`).join(' &nbsp;·&nbsp; ');
}

function footer(brand: Brand, lines: string[], links: [string, string][], disclaimer: string): string {
  const d = disclaimer.trim() ? `<tr><td style="padding:18px 8px 0;font-family:${SANS};font-size:12px;line-height:1.55;color:${C.muted}" class="muted">${esc(disclaimer).replace(/\n/g, '<br>')}</td></tr>` : '';
  return d + `<tr><td style="padding:18px 8px 8px;font-family:${SANS};font-size:12px;line-height:1.6;color:${C.muted}" class="muted">` +
    `<strong style="color:${C.text}" class="text">${esc(brand.fromName || 'Axal VC')}</strong>` +
    (brand.postalAddress ? `<br>${esc(brand.postalAddress).replace(/\n/g, ', ')}` : '') +
    (links.length ? `<br>${footerLinks(links)}` : '') +
    lines.map(l => `<br>${esc(l)}`).join('') + '</td></tr>';
}

/** Replace merge tokens in rendered output. Values are escaped for HTML. */
export function merge(s: string, r: Recipient, sender: Sender, html: boolean): string {
  const e = html ? esc : (x: string) => x;
  const vals: Record<string, string> = {
    first_name: r.firstName, last_name: r.lastName, company: r.company, email: r.email,
    unsubscribe_url: r.unsubscribeUrl, preferences_url: r.preferencesUrl, view_in_browser_url: r.viewUrl,
    sender_name: sender.name, sender_title: sender.title, sender_email: sender.email, calendar_url: sender.calendarUrl
  };
  return s.replace(/\{([a-z_]+)(?:\|([^}]*))?\}/g, (m, k: string, fb?: string) => {
    if (!(k in vals)) return m;
    // A fallback typed in the email is already escaped in the HTML.
    return vals[k] ? e(vals[k]) : fb ?? '';
  });
}

export interface RenderInput {
  content: IssueContent;
  edition: string;
  brand: Brand;
  recipient: Recipient;
  sender: Sender;
}

/** One recipient's copy of an issue. */
export function renderIssue({ content, edition, brand, recipient, sender }: RenderInput): Rendered {
  const t = content.template;
  const isLetter = t === 'letter';
  const body = content.blocks.map(b => blockHtml(b, t)).join('');
  const banner = isLetter
    ? `<tr><td style="padding:0 0 12px"><div style="border:1px solid #fcd34d;background:#fffdf5;border-radius:10px;padding:10px 14px;font-family:${SANS};font-size:12.5px;line-height:1.5;color:#92400e" class="notice">Confidential, for {first_name} {last_name} at {company|your team}. Please do not forward.</div></td></tr>`
    : '';
  const links: [string, string][] = isLetter
    ? [['Email preferences', '{preferences_url}']]
    : [['View in browser', '{view_in_browser_url}'], ['Manage preferences', '{preferences_url}'], ['Unsubscribe', '{unsubscribe_url}']];
  const lines = isLetter
    ? ['Questions? Reply to this email.']
    : ['You’re receiving this because you subscribed on axal.vc or are a contact of Axal VC.'];
  const html = page({
    subject: content.subject, preheader: content.preheader,
    headerLeft: esc(brand.fromName || 'Axal VC'),
    headerRight: esc([TEMPLATE_NAME[t].toUpperCase(), edition.toUpperCase()].filter(Boolean).join(' · ')),
    banner, body, footer: footer(brand, lines, links, brand.disclaimer)
  });
  const text = [
    `${brand.fromName || 'Axal VC'} · ${TEMPLATE_NAME[t]}${edition ? ' · ' + edition : ''}`,
    isLetter ? 'Confidential, for {first_name} {last_name} at {company|your team}. Please do not forward.' : '',
    ...content.blocks.map(blockText).filter(Boolean),
    brand.disclaimer,
    [brand.fromName || 'Axal VC', brand.postalAddress.replace(/\n/g, ', ')].filter(Boolean).join(' · '),
    isLetter ? 'Questions? Reply to this email.\nEmail preferences: {preferences_url}' : 'View in browser: {view_in_browser_url}\nManage preferences: {preferences_url}\nUnsubscribe: {unsubscribe_url}'
  ].filter(Boolean).join('\n\n');
  return { html: merge(html, recipient, sender, true), text: merge(text, recipient, sender, false) };
}

// ---------- system emails (double opt-in and confirmations) ----------

export interface SystemInput {
  kind: SystemEmailId;
  brand: Brand;
  firstName: string;
  confirmUrl?: string;
  preferencesUrl?: string;
  unsubscribeUrl?: string;
  resubscribeUrl?: string;
  /** Welcome: three "start here" links. */
  startHere?: { title: string; text: string; url: string }[];
}

export const SYSTEM_SUBJECT: Record<SystemEmailId, string> = {
  confirm: 'Confirm your subscription to Axal VC',
  welcome: 'Welcome to The Axal VC Brief',
  unsubscribed: 'You’re unsubscribed',
  preferences_saved: 'Your email preferences are saved'
};

export function renderSystem(i: SystemInput): Rendered & { subject: string } {
  const name = i.firstName.trim() || 'there';
  let body = '';
  let text = '';
  const p = (s: string) => `<p style="${P}" class="text">${s}</p>`;
  const h = (s: string) => `<h1 style="margin:0 0 12px;font-family:${SANS};font-size:24px;line-height:1.25;letter-spacing:-0.02em;color:${C.text}" class="text h1">${esc(s)}</h1>`;
  switch (i.kind) {
    case 'confirm':
      body = section(h('Confirm your subscription') + p('One click to start receiving email from Axal VC.') + button('Confirm my subscription', i.confirmUrl || '') +
        `<p style="${P};font-size:13.5px;color:${C.muted}" class="muted">If you didn’t sign up, ignore this email and you won’t hear from us.</p>`);
      text = `Confirm your subscription\n\nOne click to start receiving email from Axal VC:\n${i.confirmUrl}\n\nIf you didn’t sign up, ignore this email and you won’t hear from us.`;
      break;
    case 'welcome': {
      const rows: [string, string][] = [['FREQUENCY', 'About once a month, plus the occasional invitation.'], ['TOPICS', 'The ecosystem, our essays, events and portfolio news, as you chose.'], ['YOUR CALL', 'Change topics or leave at any time from the link in every email.']];
      body = section(h(`Welcome to The Axal VC Brief, ${name}`) + p('Thanks for confirming. Here is what to expect.') +
        table(rows.map(([k, v], n) => `<tr><td width="110" valign="top" style="${n ? `border-top:1px solid ${C.line};` : ''}padding:10px 0;font-family:${MONO};font-size:10.5px;letter-spacing:.1em;color:${C.muted}" class="muted line-top">${k}</td><td style="${n ? `border-top:1px solid ${C.line};` : ''}padding:10px 0;font-family:${SANS};font-size:15px;line-height:1.5;color:${C.text}" class="text line-top">${esc(v)}</td></tr>`).join(''))) +
        (i.startHere?.length ? section(label('Start here') + table(itemRows(i.startHere.map(s => ({ ...s, meta: '' })), 'list'))) : '') +
        section(button('Manage preferences', i.preferencesUrl || ''));
      text = `Welcome to The Axal VC Brief, ${name}\n\nThanks for confirming.\n\n${rows.map(([k, v]) => k + ': ' + v).join('\n')}` +
        (i.startHere?.length ? '\n\nSTART HERE\n' + i.startHere.map(s => `- ${s.title}: ${s.url}`).join('\n') : '') + `\n\nManage preferences: ${i.preferencesUrl}`;
      break;
    }
    case 'unsubscribed':
      body = section(h('You’re unsubscribed') + p('You won’t receive newsletters from Axal VC any more.') +
        (safeUrl(i.resubscribeUrl || '') ? `<p style="${P};font-size:14px" class="text">Changed your mind? <a href="${esc(i.resubscribeUrl!)}" style="color:${C.strong}" class="link">Resubscribe</a>.</p>` : ''));
      text = `You’re unsubscribed\n\nYou won’t receive newsletters from Axal VC any more.${i.resubscribeUrl ? '\n\nResubscribe: ' + i.resubscribeUrl : ''}`;
      break;
    case 'preferences_saved':
      body = section(h('Preferences saved') + p('Your email preferences are updated.') +
        `<p style="${P};font-size:14px" class="text"><a href="${esc(i.preferencesUrl || '')}" style="color:${C.strong}" class="link">Review your preferences</a> &nbsp;·&nbsp; <a href="${esc(i.unsubscribeUrl || '')}" style="color:${C.strong}" class="link">Unsubscribe from all</a></p>`);
      text = `Preferences saved\n\nReview: ${i.preferencesUrl}\nUnsubscribe from all: ${i.unsubscribeUrl}`;
      break;
  }
  const html = page({
    subject: SYSTEM_SUBJECT[i.kind], preheader: i.kind === 'confirm' ? 'One click to confirm your subscription.' : '',
    headerLeft: esc(i.brand.fromName || 'Axal VC'), headerRight: '', banner: '', body,
    footer: footer(i.brand, [], [], '')
  });
  return { subject: SYSTEM_SUBJECT[i.kind], html, text: text + '\n\n' + [i.brand.fromName || 'Axal VC', i.brand.postalAddress.replace(/\n/g, ', ')].filter(Boolean).join(' · ') };
}

/** Recipient used for previews and test sends: links point nowhere real. */
export const SAMPLE_RECIPIENT: Recipient = {
  firstName: 'Maya', lastName: 'Chen', company: 'Northstar AI', email: 'maya@example.com',
  unsubscribeUrl: 'https://mail.axal.vc/api/public/newsletter/preview-link', preferencesUrl: 'https://mail.axal.vc/api/public/newsletter/preview-link',
  viewUrl: 'https://mail.axal.vc/api/public/newsletter/preview-link'
};
