import { escapeHtml } from './html';

export interface Quote {
  who: string;
  time: string;
  text: string;
}

/**
 * Final email HTML. The body and signature are wrapped in marked containers
 * so a stored draft can be reopened without duplicating the signature or quote.
 */
export function assembleHtml(bodyHtml: string, signature: string | null, quote: Quote | null, footer?: string): string {
  let html = '<div class="axal-body">' + bodyHtml + '</div>';
  if (signature) html += '<div class="axal-signature" style="margin-top:16px">' + signature + '</div>';
  if (footer) html += '<div class="axal-footer" style="margin-top:12px;padding-top:10px;border-top:1px dashed #ececf1;font-size:12px;color:#6b6577">' + escapeHtml(footer) + '</div>';
  if (quote) {
    html +=
      '<div class="axal-quote" style="margin-top:16px">' +
      '<div style="color:#6b6577">On ' + escapeHtml(quote.time) + ', ' + escapeHtml(quote.who) + ' wrote:</div>' +
      '<blockquote style="margin:8px 0 0;padding-left:12px;border-left:2px solid #ececf1;color:#6b6577">' +
      escapeHtml(quote.text).replace(/\n/g, '<br>') +
      '</blockquote></div>';
  }
  return html;
}

export function assembleText(bodyText: string, signatureText: string | null, quote: Quote | null, footer?: string): string {
  let t = bodyText;
  if (signatureText) t += '\n\n-- \n' + signatureText;
  if (footer) t += '\n\n' + footer;
  if (quote) t += '\n\nOn ' + quote.time + ', ' + quote.who + ' wrote:\n' + quote.text.split('\n').map(l => '> ' + l).join('\n');
  return t;
}

/** The editable part of a stored message (drops signature and quoted text we added). */
export function extractBody(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const body = doc.querySelector('.axal-body');
  if (body) return body.innerHTML;
  doc.querySelectorAll('.axal-signature,.axal-quote,.axal-footer').forEach(n => n.remove());
  return doc.body.innerHTML;
}

