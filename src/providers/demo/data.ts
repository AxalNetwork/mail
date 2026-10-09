import type { AiInsight, Contact, DocumentRef, Identity, Profile, Schedule, Thread } from '../../types';

// Fictional sample data. Every address uses the reserved .example TLD or the firm's own domain.

export const ORG_DOMAIN = 'axal.vc';

export const CONTACTS: Contact[] = [
  { name: 'Maya Chen', email: 'maya@northstar-ai.example', org: 'Northstar AI', cat: 'Founder' },
  { name: 'Daniel Weber', email: 'daniel@meridian-ventures.example', org: 'Meridian Ventures', cat: 'Investor' },
  { name: 'Sofia Laurent', email: 'sofia@atlas-systems.example', org: 'Atlas Systems', cat: 'Operating partner' },
  { name: 'Emma Rossi', email: 'emma@horizon-labs.example', org: 'Horizon Labs', cat: 'Advisor' },
  { name: 'Alex Morgan', email: 'alex.morgan@axal.vc', org: 'Axal VC', cat: 'Operations' },
  { name: 'Priya Natarajan', email: 'priya@axal.vc', org: 'Axal VC', cat: 'Partner' },
  { name: 'Investor Relations', email: 'investors@axal.vc', org: 'Axal VC', cat: 'Shared inbox' }
];

export const IDENTITIES: Identity[] = [
  { id: 'me', addr: 'julian@axal.vc', name: 'Julian Park', kind: 'Your mailbox', short: 'Personal', note: '', isDefault: true },
  { id: 'inv', addr: 'investors@axal.vc', name: 'Axal VC Investor Relations', kind: 'Shared inbox · you are a member', short: 'Shared inbox', note: 'Recipients see "Axal VC Investor Relations". Your name is recorded as the author in the audit log.' },
  { id: 'fdr', addr: 'founders@axal.vc', name: 'Axal VC Founders', kind: 'Shared inbox · you are a member', short: 'Shared inbox', note: 'Recipients see "Axal VC Founders". Your name is recorded as the author in the audit log.' },
  { id: 'del', addr: 'priya@axal.vc', name: 'Priya Natarajan', kind: 'Delegated by Priya · send on behalf', short: 'On behalf', note: 'Recipients see "Julian Park on behalf of Priya Natarajan". Priya is notified of every message sent this way.' }
];

export const MAILBOXES = [
  { addr: 'julian@axal.vc', access: 'Owner' },
  { addr: 'investors@axal.vc', access: 'Shared · member' },
  { addr: 'founders@axal.vc', access: 'Shared · member' },
  { addr: 'priya@axal.vc', access: 'Delegated · send on behalf' }
];

export const DOCS: DocumentRef[] = [
  { id: 'd1', name: 'Northstar_Seed_Deck_v3.pdf', ext: 'PDF', cls: 'Confidential', size: 4.2e6 },
  { id: 'd2', name: 'Axal_Fund_I_Q3_LP_Update.pdf', ext: 'PDF', cls: 'Restricted', size: 1.8e6 },
  { id: 'd3', name: 'Mutual_NDA_Atlas_Systems.docx', ext: 'DOCX', cls: 'Internal', size: 88e3 },
  { id: 'd4', name: 'Axal_VC_Founder_FAQ.pdf', ext: 'PDF', cls: 'Public', size: 640e3 }
];

export const PROFILES: Profile[] = [
  { id: 'julian', first: 'Julian', last: 'Park', title: 'Managing Partner', region: 'North America', email: 'julian@axal.vc', whatsapp: '+1 212 555 0148', linkedin: 'linkedin.com/in/julianpark-axal', photo: true },
  { id: 'priya', first: 'Priya', last: 'Natarajan', title: 'Partner', region: 'Europe & Middle East', email: 'priya@axal.vc', whatsapp: '+44 20 7946 0321', linkedin: 'linkedin.com/in/priyanatarajan-axal', photo: true },
  { id: 'alex', first: 'Alex', last: 'Morgan', title: 'Head of Operations', region: 'Global', email: 'alex.morgan@axal.vc', whatsapp: '', linkedin: 'linkedin.com/in/alexmorgan-axal', photo: false },
  { id: 'samira', first: 'Samira', last: 'Okafor', title: 'Licensed Administrator', region: '', email: 'samira.okafor@axal.vc', whatsapp: '+1 646 555 0193', linkedin: '', photo: true }
];

export const SCHEDULES: Schedule[] = [
  { label: 'Tomorrow morning', when: 'Sat 08:00' },
  { label: 'Monday morning', when: 'Mon 09:00' },
  { label: 'Monday afternoon', when: 'Mon 14:00' }
];

export const OPT_OUTS: Record<string, string> = { 'lena@kestrel-capital.example': 'Opted out of bulk email on 2 Sep' };

export const CATEGORIES = ['Primary', 'Partners', 'Investors', 'Founders', 'Operations', 'Notifications'];

export interface DemoThread extends Thread {
  cat: string;
  owner: string;
  archived?: boolean;
  snoozed?: boolean;
  folder?: 'sent' | 'draft' | 'scheduled';
}

const att = (name: string, ext: string, size: number, mime: string) => ({ name, ext, size, mime });

export const THREADS: DemoThread[] = [
  {
    id: 't1', cat: 'Founders', from: 'Maya Chen', org: 'Northstar AI', email: 'maya@northstar-ai.example', time: '09:42', unread: true, starred: true,
    subject: 'Northstar AI — seed round, intro via Emma Rossi', labels: ['Founders', 'Seed'], attachCount: 1, owner: 'Julian Park',
    snippet: 'Emma Rossi suggested I reach out. Northstar AI builds evaluation tooling for teams deploying LLM agents…',
    messages: [{
      id: 'm1', from: 'Maya Chen', email: 'maya@northstar-ai.example', to: 'Julian Park', time: 'Today 09:42',
      attachments: [att('Northstar_Seed_Deck_v3.pdf', 'PDF', 4.2e6, 'application/pdf')],
      text: "Hi Julian,\n\nEmma Rossi suggested I reach out. Northstar AI builds evaluation tooling for teams deploying LLM agents in regulated industries. We have 11 paying design partners and are raising a $4M seed, with $1.5M committed from our lead angel.\n\nI've attached our current deck. Would you have 30 minutes next week? Tuesday or Thursday afternoon works on my side.\n\nBest,\nMaya"
    }],
    activity: [{ text: 'Associated with Northstar AI · suggested by AI, confirmed by Alex Morgan', time: '09:50' }, { text: 'Deck filed in Documents › Northstar AI as Confidential', time: '09:51' }],
    linkText: ''
  },
  {
    id: 't2', cat: 'Investors', from: 'Daniel Weber', org: 'Meridian Ventures', email: 'daniel@meridian-ventures.example', time: 'Yesterday', unread: true, starred: false, followup: 'Reply by Fri', sensitive: true,
    subject: 'Q3 portfolio update — timing?', labels: ['Investors', 'LP'], attachCount: 0, owner: 'Priya Natarajan',
    snippet: 'Our IC meets on 22 October. Could you share the Q3 portfolio update before then?',
    messages: [{
      id: 'm2', from: 'Daniel Weber', email: 'daniel@meridian-ventures.example', to: 'Julian Park; investors@axal.vc', time: 'Yesterday 16:20', attachments: [],
      recipients: [{ name: 'Julian Park', email: 'julian@axal.vc', org: 'Axal VC' }, { name: 'Investor Relations', email: 'investors@axal.vc', org: 'Axal VC' }],
      text: "Hi Julian,\n\nOur IC meets on 22 October. Could you share the Q3 portfolio update before then? In particular we'd like the revised marks on the two Fund I positions we discussed in July.\n\nThanks,\nDaniel"
    }],
    activity: [{ text: 'Flagged Sensitive: fund information requested', time: 'Yesterday 16:21' }, { text: 'Follow-up set for Friday by Priya Natarajan', time: 'Yesterday 17:02' }],
    linkText: ''
  },
  {
    id: 't3', cat: 'Primary', from: 'Emma Rossi', org: 'Horizon Labs', email: 'emma@horizon-labs.example', time: 'Tue', unread: false, starred: false,
    subject: 'Advisory session — week of 19 October', labels: ['Advisors'], attachCount: 0, owner: 'Julian Park',
    snippet: 'Happy to run the go-to-market session for the spring cohort. Would the 20th or 21st work?',
    messages: [{
      id: 'm3', from: 'Emma Rossi', email: 'emma@horizon-labs.example', to: 'Julian Park', time: 'Tue 11:05', attachments: [],
      text: 'Julian,\n\nHappy to run the go-to-market session for the spring cohort. Would the 20th or 21st work? I can do 90 minutes, in person or remote.\n\nAlso, I passed Maya Chen your details — I think Northstar is worth a look.\n\nEmma'
    }],
    activity: [],
    linkText: ''
  },
  {
    id: 't4', cat: 'Operations', from: 'Alex Morgan', org: 'Axal VC', email: 'alex.morgan@axal.vc', time: 'Tue', unread: false, starred: false, attachCount: 1,
    subject: 'Need countersigned NDA — Atlas Systems', labels: ['Operations', 'NDA'], owner: 'Alex Morgan',
    snippet: 'Atlas sent their signature on Monday. We still need yours before Sofia can share the operating data.',
    messages: [{
      id: 'm4', from: 'Alex Morgan', email: 'alex.morgan@axal.vc', to: 'Julian Park', time: 'Tue 08:30',
      attachments: [att('Mutual_NDA_Atlas_Systems.docx', 'DOCX', 88e3, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')],
      text: 'Julian,\n\nAtlas sent their signature on Monday. We still need yours before Sofia can share the operating data. Signature page is 4.\n\nThanks,\nAlex'
    }],
    activity: [{ text: 'Task created: countersign NDA · due Thu', time: 'Tue 08:31' }],
    linkText: ''
  },
  {
    id: 't5', cat: 'Partners', from: 'Priya Natarajan', org: 'Axal VC', email: 'priya@axal.vc', time: 'Mon', unread: false, starred: false, sensitive: true,
    subject: 'Approval needed: reply to Meridian on fee question', labels: ['Approval'], attachCount: 0, owner: 'Priya Natarajan',
    snippet: 'Draft below for Daniel. Can you approve before it goes from investors@?',
    messages: [{
      id: 'm5', from: 'Priya Natarajan', email: 'priya@axal.vc', to: 'Julian Park', time: 'Mon 18:12', attachments: [],
      text: 'Julian,\n\nDraft below for Daniel. Can you approve before it goes from investors@? It restates the fee terms from the LPA, nothing new.\n\nPriya'
    }],
    activity: [{ text: 'Approval requested from Julian Park', time: 'Mon 18:12' }],
    linkText: ''
  },
  {
    id: 't6', cat: 'Partners', from: 'Sofia Laurent', org: 'Atlas Systems', email: 'sofia@atlas-systems.example', time: '5 Oct', unread: false, starred: false, followup: 'Awaiting you · 4d',
    subject: 'Re: Atlas operating review — waiting on your input', labels: ['Portfolio'], attachCount: 0, owner: 'Julian Park',
    snippet: "Just checking in on the hiring plan comments before Thursday's board prep.",
    messages: [{
      id: 'm6', from: 'Sofia Laurent', email: 'sofia@atlas-systems.example', to: 'Julian Park', time: '5 Oct 10:14', attachments: [],
      text: "Hi Julian,\n\nJust checking in on the hiring plan comments before Thursday's board prep. Even a short note on the two senior roles would help.\n\nSofia"
    }],
    activity: [{ text: 'No reply for 4 days · reminder from automation "Unanswered follow-up"', time: '9 Oct 08:00' }],
    linkText: ''
  },
  {
    id: 't7', cat: 'Notifications', from: 'Axal VC', org: 'Platform', email: 'notifications@axal.vc', time: 'Mon', unread: false, starred: false, noReply: true,
    subject: 'Weekly digest: 3 tasks due this week', labels: ['Digest'], attachCount: 0, owner: '—',
    snippet: 'Countersign NDA (Thu) · Q3 LP update review (Fri) · Advisory session booking (Fri)',
    messages: [{
      id: 'm7', from: 'Axal VC', email: 'notifications@axal.vc', to: 'Julian Park', time: 'Mon 07:00', attachments: [],
      text: 'Due this week:\n• Countersign NDA — Atlas Systems (Thu)\n• Review Q3 LP update (Fri)\n• Book advisory session with Emma Rossi (Fri)'
    }],
    activity: [],
    linkText: ''
  }
];

export interface DemoInsight extends AiInsight {
  /** French translation of the suggested draft. */
  fr?: string;
}

export const INSIGHTS: Record<string, DemoInsight> = {
  t1: {
    summary: 'Maya Chen (Founder, Northstar AI) was introduced by Emma Rossi. She is raising a $4M seed with $1.5M committed and asks for a 30-minute call next Tuesday or Thursday afternoon.',
    points: [
      { kind: 'Request', text: '30-minute call, Tuesday or Thursday afternoon next week.', src: 'Maya Chen · 09:42', tone: 'accent' },
      { kind: 'Stated by sender, not verified', text: '$4M seed, $1.5M committed, 11 paying design partners.', src: 'Maya Chen · 09:42', tone: 'warn' },
      { kind: 'Gap', text: 'No earlier correspondence with Northstar AI in mail you can access.', src: 'Search of your authorized mailboxes', tone: 'muted' }
    ],
    draft: "<p>Hi Maya,</p><p>Thank you for reaching out, and thanks to Emma for the introduction. I've started on the deck and would be glad to talk.</p><p>Thursday afternoon works for me. Would 3:00 pm ET suit you? I'll send a calendar invite once you confirm.</p><p>Best regards,</p>",
    fr: "<p>Bonjour Maya,</p><p>Merci de m'avoir contacté, et merci à Emma pour la mise en relation. J'ai commencé à parcourir le deck et serais ravi d'en discuter.</p><p>Jeudi après-midi me convient. 15 h 00 (heure de New York) vous irait-il ? Je vous enverrai une invitation dès votre confirmation.</p><p>Bien cordialement,</p>"
  },
  t2: {
    summary: 'Daniel Weber (Meridian Ventures) asks for the Q3 portfolio update before their 22 October IC, including revised marks on two Fund I positions.',
    points: [
      { kind: 'Deadline', text: 'Meridian IC meets 22 October.', src: 'Daniel Weber · yesterday', tone: 'accent' },
      { kind: 'Earlier commitment', text: 'Your 14 July reply said the Q3 update would go out "mid-October".', src: 'Sent · 14 Jul', tone: 'warn' },
      { kind: 'Sensitive', text: 'Revised marks are fund information. Sharing them needs partner approval.', src: 'AI policy · fund information', tone: 'danger' }
    ],
    draft: "<p>Hi Daniel,</p><p>Thanks for the note. The Q3 update is in final review and we expect to send it ahead of your 22 October IC.</p><p>I'll confirm the exact date by Friday.</p><p>Best regards,</p>"
  },
  t3: {
    summary: 'Emma Rossi offers a 90-minute go-to-market session for the spring cohort on 20 or 21 October, and mentions she introduced Maya Chen.',
    points: [{ kind: 'Request', text: 'Choose 20 or 21 October; in person or remote.', src: 'Emma Rossi · Tue', tone: 'accent' }],
    draft: "<p>Emma,</p><p>Thank you, that would be great. The 21st works best for us. Could we do 2:00 to 3:30 pm, in person at the office?</p><p>And thanks for sending Maya our way. We're speaking this week.</p><p>Best,</p>"
  },
  t4: {
    summary: 'Alex needs your countersignature on the Atlas Systems mutual NDA (page 4) before Sofia Laurent shares operating data.',
    points: [{ kind: 'Action for you', text: 'Countersign page 4 of the NDA.', src: 'Alex Morgan · Tue', tone: 'accent' }],
    draft: '<p>Alex,</p><p>Signed and attached. Please send the executed copy to Sofia and file it under Atlas Systems.</p><p>Thanks,</p>'
  },
  t5: {
    summary: 'Priya asks you to approve a reply to Meridian Ventures restating LPA fee terms, to be sent from investors@axal.vc.',
    points: [{ kind: 'Approval', text: 'Your approval is required before sending.', src: 'Approval request · Mon', tone: 'danger' }],
    draft: '<p>Priya,</p><p>Approved, with one change: cite the LPA section number in the second paragraph.</p><p>Thanks,</p>'
  },
  t6: {
    summary: "Sofia Laurent is waiting on your comments on the Atlas hiring plan, specifically the two senior roles, before Thursday's board prep.",
    points: [{ kind: 'Unanswered', text: 'No reply from you since 5 October.', src: 'Thread history', tone: 'warn' }],
    draft: "<p>Hi Sofia,</p><p>Apologies for the delay. On the two senior roles: I'd prioritise the VP Engineering hire this quarter and move the Head of Sales search to Q1.</p><p>Happy to discuss before Thursday.</p><p>Best,</p>"
  }
};

export const SAMPLE_CSV =
  'email,first_name,last_name,company,persona,context\n' +
  'maya@northstar-ai.example,Maya,Chen,Northstar AI,Founder,your seed round\n' +
  'daniel@meridian-ventures.example,Daniel,Weber,Meridian Ventures,Investor,the Q3 update\n' +
  'sofia@atlas-systems.example,Sofia,Laurent,Atlas Systems,Operating partner,\n' +
  'emma@horizon-labs.example,Emma,Rossi,Horizon Labs,Advisor,the spring cohort session\n' +
  'omar@tidewater-bio.example,Omar,Haddad,Tidewater Bio,Founder,\n' +
  'raj@harbor-family-office.example,Raj,Mehta,Harbor Family Office,LP,\n' +
  'lena@kestrel-capital.example,Lena,Hoffmann,Kestrel Capital,Limited partner,\n' +
  'chris@vantage-angels.example,Chris,,,Angel investor,\n' +
  'maya@northstar-ai.example,Maya,Chen,Northstar AI,Founder,\n' +
  'noah.kim@,Noah,Kim,Pinecone Robotics,Founder,\n' +
  'alex.morgan@axal.vc,Alex,Morgan,Axal VC,,';

export const DEFAULT_BRIEF = 'the Spin-Out Lab demo day on Thursday 12 November, 4 to 7 pm, at our New York office';
