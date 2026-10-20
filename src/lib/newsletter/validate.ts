import type { Block, Item, TemplateId } from './types';

/** Template ids, and a cleaner that keeps only known blocks and fields, within limits. */

export const TEMPLATE_IDS: TemplateId[] = ['brief', 'letter', 'spotlight', 'founder', 'event_invite', 'event_recap', 'insights', 'announcement', 'pt_in', 'pt_not', 'pt_reminder', 'pt_survey', 'pt_thanks'];
export const isTemplate = (v: unknown): v is TemplateId => typeof v === 'string' && (TEMPLATE_IDS as string[]).includes(v);

export const MAX_BLOCKS = 40;
const s = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').slice(0, max) : '');
const id = (v: unknown, i: number) => (typeof v === 'string' && /^[\w-]{1,40}$/.test(v) ? v : 'b' + i);

function items(v: unknown): Item[] {
  return (Array.isArray(v) ? v : []).slice(0, 12).map((x: Record<string, unknown>) => ({
    title: s(x?.title, 200), text: s(x?.text, 600), meta: s(x?.meta, 60), url: s(x?.url, 600)
  }));
}

export function cleanBlocks(raw: unknown): Block[] {
  if (!Array.isArray(raw)) return [];
  const out: Block[] = [];
  raw.slice(0, MAX_BLOCKS).forEach((b: Record<string, unknown>, i) => {
    const bid = id(b?.id, i);
    const before = out.length;
    switch (b?.type) {
      case 'hero': out.push({ id: bid, type: 'hero', kicker: s(b.kicker, 80), title: s(b.title, 160), text: s(b.text, 1200) }); break;
      case 'note': out.push({ id: bid, type: 'note', label: s(b.label, 80), text: s(b.text, 12000), name: s(b.name, 80), title: s(b.title, 100) }); break;
      case 'essay': out.push({ id: bid, type: 'essay', label: s(b.label, 80), title: s(b.title, 160), text: s(b.text, 400), meta: s(b.meta, 60), url: s(b.url, 600) }); break;
      case 'items': out.push({ id: bid, type: 'items', label: s(b.label, 80), items: items(b.items), footerLabel: s(b.footerLabel, 60), footerUrl: s(b.footerUrl, 600) }); break;
      case 'events': out.push({ id: bid, type: 'events', label: s(b.label, 80), items: items(b.items) }); break;
      case 'text': out.push({ id: bid, type: 'text', label: s(b.label, 80), heading: s(b.heading, 160), text: s(b.text, 20000) }); break;
      case 'quote': out.push({ id: bid, type: 'quote', text: s(b.text, 400), attribution: s(b.attribution, 120) }); break;
      case 'image': out.push({ id: bid, type: 'image', src: s(b.src, 1000), alt: s(b.alt, 200), url: s(b.url, 600), caption: s(b.caption, 200) }); break;
      case 'button': out.push({ id: bid, type: 'button', label: s(b.label, 60), url: s(b.url, 600), secondaryLabel: s(b.secondaryLabel, 60), secondaryUrl: s(b.secondaryUrl, 600) }); break;
      case 'callout': out.push({ id: bid, type: 'callout', value: s(b.value, 24), text: s(b.text, 200), source: s(b.source, 120) }); break;
      case 'tags': out.push({ id: bid, type: 'tags', tags: (Array.isArray(b.tags) ? b.tags : []).slice(0, 6).map(t => s(t, 30)) }); break;
      case 'divider': out.push({ id: bid, type: 'divider' }); break;
    }
    if (out.length > before && b.hidden === true) out[out.length - 1].hidden = true;
  });
  return out;
}

/** Every link and image address in the blocks, for the pre-send check. */
export function blockUrls(blocks: Block[]): { url: string; where: string }[] {
  const out: { url: string; where: string }[] = [];
  const add = (url: string, where: string) => { if (url.trim()) out.push({ url: url.trim(), where }); };
  blocks.forEach((b, n) => {
    const w = '#' + (n + 1) + ' ' + b.type;
    if (b.type === 'essay') add(b.url, w);
    if (b.type === 'items' || b.type === 'events') { b.items.forEach(i => add(i.url, w)); if (b.type === 'items') add(b.footerUrl, w); }
    if (b.type === 'image') { add(b.src, w + ' (image)'); add(b.url, w); }
    if (b.type === 'button') { add(b.url, w); add(b.secondaryUrl, w); }
    if (b.type === 'text' || b.type === 'note' || b.type === 'hero') for (const m of b.text.matchAll(/\]\(([^)\s]+)\)/g)) add(m[1], w);
  });
  return out;
}
