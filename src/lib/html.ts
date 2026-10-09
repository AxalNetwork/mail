export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Plain text → simple paragraph HTML. Blank lines split paragraphs. */
export function textToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map(p => '<p>' + escapeHtml(p).replace(/\n/g, '<br>') + '</p>')
    .join('');
}

/** HTML → readable plain text, for text/plain parts, snippets and checks. */
export function htmlToText(html: string): string {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,style,head').forEach(n => n.remove());
  doc.querySelectorAll('br').forEach(n => n.replaceWith('\n'));
  doc.querySelectorAll('li').forEach(n => n.prepend('• '));
  doc.querySelectorAll('p,div,li,blockquote,h1,h2,h3,h4,tr,ul,ol').forEach(n => n.append('\n'));
  const text = doc.body.textContent || '';
  return text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
