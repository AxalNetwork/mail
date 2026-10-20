import type { Block, Item, TemplateId } from './types';
import { TEMPLATE_NAME } from './render';

/**
 * The eight newsletter templates (from the Claude Design template set): each
 * starts as an ordered list of blocks with placeholder copy in [brackets].
 * Blocks can be edited, reordered, hidden or removed; the header, the card and
 * the footer (address, preferences, unsubscribe, disclaimer) always stay.
 */

let n = 0;
export const blockId = () => 'b' + Date.now().toString(36) + (n++).toString(36);

const item = (title: string, text = '', meta = '', url = ''): Item => ({ title, text, meta, url });

export interface TemplateDef {
  id: TemplateId;
  name: string;
  description: string;
  audience: string;
  /** Default list keys for a new issue. */
  lists: string[];
  subject: string;
  preheader: string;
  blocks: () => Block[];
}

export const TEMPLATES: TemplateDef[] = [
  {
    id: 'brief', name: TEMPLATE_NAME.brief, description: 'Monthly newsletter: editor’s note, featured essay, portfolio and ecosystem news, roles, events.',
    audience: 'Website subscribers', lists: ['brief'], subject: 'The Axal VC Brief: [month]', preheader: '[One line on what is in this issue]',
    blocks: () => [
      { id: blockId(), type: 'note', label: 'From the partners', text: '[About 80 words from a partner: what the team is thinking about this month.]', name: '[Partner name]', title: '[Partner title]' },
      { id: blockId(), type: 'essay', label: 'What we’re thinking', title: '[Featured essay headline]', text: '[Two-line summary of the essay]', meta: 'ESSAY · 8 MIN READ', url: 'https://axal.vc/' },
      { id: blockId(), type: 'items', label: 'Portfolio news', items: [item('[Company]', '[One line of news]', '', 'https://axal.vc/'), item('[Company]', '[One line of news]'), item('[Company]', '[One line of news]')], footerLabel: '', footerUrl: '' },
      { id: blockId(), type: 'items', label: 'From the ecosystem', items: [item('[Link title]', '[Why it matters]', '[SOURCE]', 'https://'), item('[Link title]', '[Why it matters]', '[SOURCE]', 'https://'), item('[Link title]', '[Why it matters]', '[SOURCE]', 'https://')], footerLabel: '', footerUrl: '' },
      { id: blockId(), type: 'items', label: 'Open roles', items: [item('[Role]', '[Company]', '[City]', 'https://'), item('[Role]', '[Company]', '[City]', 'https://'), item('[Role]', '[Company]', '[City]', 'https://')], footerLabel: 'All roles', footerUrl: 'https://axal.vc/' },
      { id: blockId(), type: 'events', label: 'Events', items: [item('[Event name]', '[When and where]', 'OCT 24', 'https://')] },
      { id: blockId(), type: 'text', label: '', heading: '', text: '[Closing line.]' }
    ]
  },
  {
    id: 'letter', name: TEMPLATE_NAME.letter, description: 'Quarterly letter to investors and LPs: qualitative only, confidential banner, approval required.',
    audience: 'LPs & investors', lists: ['lps'], subject: 'Partner Letter · [Q3 2026]', preheader: '[One line on this quarter]',
    blocks: () => [
      { id: blockId(), type: 'note', label: '[Q3 2026] · [date]', text: 'Dear {first_name|partner},\n\n[Partner letter, 400 to 800 words. Qualitative only: no returns, valuations, fund terms or anything that reads as an offer.]', name: '{sender_name}', title: '{sender_title}' },
      { id: blockId(), type: 'items', label: 'Portfolio highlights', items: [item('[Company]', '[Milestone: hire, launch, partnership. No figures.]'), item('[Company]', '[Milestone]'), item('[Company]', '[Milestone]')], footerLabel: '', footerUrl: '' },
      { id: blockId(), type: 'items', label: 'Team', items: [item('[Name]', '[Joined as / now leads …]')], footerLabel: '', footerUrl: '' },
      { id: blockId(), type: 'events', label: 'Upcoming', items: [item('[Annual meeting]', '[Detail]', 'NOV 12'), item('[Reporting date]', '[Detail]', 'DEC 15')] },
      { id: blockId(), type: 'text', label: 'Contact', heading: '', text: 'Write to me at [{sender_email}](mailto:{sender_email}) or [book a time]({calendar_url}).' }
    ]
  },
  {
    id: 'spotlight', name: TEMPLATE_NAME.spotlight, description: 'One portfolio company: the problem, what they built, why we backed them, how you can help.',
    audience: 'Portfolio news subscribers', lists: ['portfolio'], subject: 'Portfolio Spotlight: [Company]', preheader: '[Company] [one line]',
    blocks: () => [
      { id: blockId(), type: 'hero', kicker: 'Portfolio spotlight', title: '[Company name]', text: '[One-line description]' },
      { id: blockId(), type: 'tags', tags: ['[Sector]', '[Stage]', '[City]'] },
      { id: blockId(), type: 'quote', text: '[Founder quote]', attribution: '[NAME, ROLE · NAME, ROLE]' },
      { id: blockId(), type: 'text', label: 'The problem', heading: '', text: '[What is broken, in plain words.]' },
      { id: blockId(), type: 'text', label: 'What they built', heading: '', text: '[The product.]' },
      { id: blockId(), type: 'image', src: '', alt: '[Product screenshot: what it shows]', url: '', caption: '' },
      { id: blockId(), type: 'text', label: 'Why we backed them', heading: '', text: '[Qualitative reasons only.]' },
      { id: blockId(), type: 'items', label: 'How you can help', items: [item('[Intros]', '[Who they want to meet]', '', 'https://'), item('[Hires]', '[Roles they are filling]', '', 'https://'), item('[Customers]', '[Who should try it]', '', 'https://')], footerLabel: '', footerUrl: '' }
    ]
  },
  {
    id: 'founder', name: TEMPLATE_NAME.founder, description: 'Invitation to founders building in a sector: thesis, what we look for, how we work.',
    audience: 'Founders', lists: ['founders'], subject: 'Building in [sector]?', preheader: 'What we look for, and how to share your deck',
    blocks: () => [
      { id: blockId(), type: 'hero', kicker: 'For founders', title: 'Building in [sector]?', text: '[Two lines on our thesis for the sector.]' },
      { id: blockId(), type: 'text', label: 'What we look for', heading: '', text: '- [Point]\n- [Point]\n- [Point]' },
      { id: blockId(), type: 'text', label: 'How we work with founders', heading: '', text: '1. [First point]\n2. [Second point]\n3. [Third point]' },
      { id: blockId(), type: 'button', label: 'Share your deck', url: 'https://axal.vc/contact', secondaryLabel: 'Read our thesis', secondaryUrl: 'https://axal.vc/' },
      { id: blockId(), type: 'note', label: '', text: '[One personal line.]', name: '[Partner name]', title: '[Partner title]' }
    ]
  },
  {
    id: 'event_invite', name: TEMPLATE_NAME.event_invite, description: 'Event invitation: date, time and place, agenda, speakers, request a seat.',
    audience: 'Events subscribers', lists: ['events'], subject: 'You’re invited: [event name]', preheader: '[Date] · [place]',
    blocks: () => [
      { id: blockId(), type: 'hero', kicker: 'Invitation', title: '[Event name]', text: '[One or two lines about the event.]' },
      { id: blockId(), type: 'items', label: 'When and where', items: [item('[Thursday 24 October]', '', 'DATE'), item('[18:30 – 21:00]', '', 'TIME'), item('[Venue, city] or Online', '', 'PLACE')], footerLabel: '', footerUrl: '' },
      { id: blockId(), type: 'items', label: 'Agenda', items: [item('[Welcome]', '', '18:30'), item('[Panel]', '', '19:00'), item('[Drinks]', '', '20:00')], footerLabel: '', footerUrl: '' },
      { id: blockId(), type: 'items', label: 'Speakers', items: [item('[Name]', '[Title, company]'), item('[Name]', '[Title, company]')], footerLabel: '', footerUrl: '' },
      { id: blockId(), type: 'button', label: 'Request a seat', url: 'https://', secondaryLabel: 'Add to calendar', secondaryUrl: 'https://' },
      { id: blockId(), type: 'text', label: '', heading: '', text: '[Capacity: about 60 seats; we confirm requests by email.]' }
    ]
  },
  {
    id: 'event_recap', name: TEMPLATE_NAME.event_recap, description: 'Sent to attendees afterwards: takeaways, photos, recording, next event.',
    audience: 'Attendees', lists: ['events'], subject: 'Thanks for coming, {first_name|there}', preheader: 'Three takeaways and the recording',
    blocks: () => [
      { id: blockId(), type: 'hero', kicker: 'Event recap', title: 'Thanks for coming, {first_name|there}', text: '[One line on the evening.]' },
      { id: blockId(), type: 'text', label: 'Three takeaways', heading: '', text: '1. **[Takeaway]** [One or two lines]\n2. **[Takeaway]** [One or two lines]\n3. **[Takeaway]** [One or two lines]' },
      { id: blockId(), type: 'image', src: '', alt: '[Photo from the event]', url: '', caption: '' },
      { id: blockId(), type: 'button', label: 'Watch the recording', url: 'https://', secondaryLabel: 'Slides', secondaryUrl: 'https://' },
      { id: blockId(), type: 'events', label: 'Next event', items: [item('[Next event]', '[When and where]', 'NOV 21', 'https://')] }
    ]
  },
  {
    id: 'insights', name: TEMPLATE_NAME.insights, description: 'One essay in full: headings, pull quote, data callout, footnotes.',
    audience: 'Insights subscribers', lists: ['insights'], subject: '[Essay title]', preheader: '[One-line summary]',
    blocks: () => [
      { id: blockId(), type: 'hero', kicker: '[Author] · [date] · [8 min read]', title: '[Essay title]', text: '' },
      { id: blockId(), type: 'button', label: 'Read on axal.vc', url: 'https://axal.vc/', secondaryLabel: '', secondaryUrl: '' },
      { id: blockId(), type: 'text', label: '', heading: '', text: '[Opening paragraph.]\n\n## [Section heading]\n\n[Paragraphs. Use - for bullets and 1. for numbered lists.]' },
      { id: blockId(), type: 'quote', text: '[Pull quote]', attribution: '' },
      { id: blockId(), type: 'callout', value: '[3×]', text: '[What the number shows]', source: '[Source]' },
      { id: blockId(), type: 'text', label: '', heading: '', text: '[More paragraphs.]\n\n### Notes\n\n1. [Footnote]' },
      { id: blockId(), type: 'button', label: 'Read on axal.vc', url: 'https://axal.vc/', secondaryLabel: '', secondaryUrl: '' }
    ]
  },
  {
    id: 'announcement', name: TEMPLATE_NAME.announcement, description: 'Firm news, strictly factual: headline, summary, what it means for you.',
    audience: 'All subscribers', lists: ['brief'], subject: '[Headline]', preheader: '[One-line summary]',
    blocks: () => [
      { id: blockId(), type: 'hero', kicker: 'Announcement', title: '[Headline]', text: '[Two or three factual sentences. No fund size or performance language.]' },
      { id: blockId(), type: 'image', src: '', alt: '[Portrait or image: who or what it shows]', url: '', caption: '' },
      { id: blockId(), type: 'button', label: 'Read the full announcement', url: 'https://axal.vc/', secondaryLabel: '', secondaryUrl: '' },
      { id: blockId(), type: 'text', label: 'What this means for you', heading: '', text: '[For founders / LPs / the ecosystem: keep the one that matches the audience.]' }
    ]
  }
];

export const templateDef = (id: TemplateId) => TEMPLATES.find(t => t.id === id) || TEMPLATES[0];

/** A new, empty block of a type. */
export function emptyBlock(type: Block['type']): Block {
  const id = blockId();
  switch (type) {
    case 'hero': return { id, type, kicker: '', title: '', text: '' };
    case 'note': return { id, type, label: '', text: '', name: '', title: '' };
    case 'essay': return { id, type, label: '', title: '', text: '', meta: '', url: '' };
    case 'items': return { id, type, label: '', items: [item('')], footerLabel: '', footerUrl: '' };
    case 'events': return { id, type, label: 'Events', items: [item('', '', '')] };
    case 'text': return { id, type, label: '', heading: '', text: '' };
    case 'quote': return { id, type, text: '', attribution: '' };
    case 'image': return { id, type, src: '', alt: '', url: '', caption: '' };
    case 'button': return { id, type, label: '', url: '', secondaryLabel: '', secondaryUrl: '' };
    case 'callout': return { id, type, value: '', text: '', source: '' };
    case 'tags': return { id, type, tags: [''] };
    case 'divider': return { id, type };
  }
}

/** Text an author can still see in the copy that looks like an unfilled placeholder. */
export function placeholders(blocks: Block[], subject: string, preheader: string): string[] {
  const all = JSON.stringify(blocks) + subject + preheader;
  // Bracketed text that isn't the label of a [link](url).
  return [...new Set(all.match(/\[[^\]\n]{2,60}\](?!\()/g) || [])].slice(0, 10);
}
