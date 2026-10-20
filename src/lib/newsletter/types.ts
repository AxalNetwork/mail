/**
 * Newsletter content model, shared by the app (editor and live preview) and
 * the Worker (rendering each recipient's copy at send time). An issue is a
 * template plus an ordered list of blocks; every block is plain text with a
 * small markup (paragraphs, **bold**, *italic*, [link](https://…), "- " lists,
 * "1. " lists, and in long reads "## " headings).
 */

export type TemplateId =
  | 'brief' | 'letter' | 'spotlight' | 'founder' | 'event_invite' | 'event_recap' | 'insights' | 'announcement'
  // Emails to a product-testing programme's applicants and testers.
  | 'pt_in' | 'pt_not' | 'pt_reminder' | 'pt_survey' | 'pt_thanks';

export type SystemEmailId = 'confirm' | 'welcome' | 'unsubscribed' | 'preferences_saved';

export interface Item { title: string; text: string; url: string; meta: string }

/** A block marked hidden ("Remove section") stays in the draft but is not sent. */
export type Block = { hidden?: boolean } & (
  | { id: string; type: 'note'; label: string; text: string; name: string; title: string }
  | { id: string; type: 'essay'; label: string; title: string; text: string; meta: string; url: string }
  | { id: string; type: 'items'; label: string; items: Item[]; footerLabel: string; footerUrl: string }
  | { id: string; type: 'events'; label: string; items: Item[] }
  | { id: string; type: 'text'; label: string; heading: string; text: string }
  | { id: string; type: 'quote'; text: string; attribution: string }
  | { id: string; type: 'image'; src: string; alt: string; url: string; caption: string }
  | { id: string; type: 'button'; label: string; url: string; secondaryLabel: string; secondaryUrl: string }
  | { id: string; type: 'callout'; value: string; text: string; source: string }
  | { id: string; type: 'tags'; tags: string[] }
  | { id: string; type: 'hero'; kicker: string; title: string; text: string }
  | { id: string; type: 'divider' });

export type BlockType = Block['type'];

export interface IssueContent {
  template: TemplateId;
  subject: string;
  preheader: string;
  blocks: Block[];
}

/** Brand and legal settings that every email carries. */
export interface Brand {
  fromName: string;
  postalAddress: string;
  disclaimer: string;
}

/** Who the copy is for, and the links that are personal to them. */
export interface Recipient {
  firstName: string;
  lastName: string;
  company: string;
  email: string;
  unsubscribeUrl: string;
  preferencesUrl: string;
  viewUrl: string;
}

export interface Sender { name: string; title: string; email: string; calendarUrl: string }

export interface Rendered { html: string; text: string }

export const BLOCK_LABEL: Record<BlockType, string> = {
  hero: 'Hero', note: 'Editor’s note', essay: 'Essay teaser', items: 'List of items', events: 'Events', text: 'Text',
  quote: 'Quote', image: 'Image', button: 'Button', callout: 'Data callout', tags: 'Tags', divider: 'Divider'
};
