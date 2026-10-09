export interface BulkField {
  k: 'email' | 'first_name' | 'last_name' | 'company' | 'persona' | 'context';
  label: string;
  alias: string[];
}

export const BULK_FIELDS: BulkField[] = [
  { k: 'email', label: 'Email (required)', alias: ['email', 'e-mail', 'email address', 'mail'] },
  { k: 'first_name', label: 'First name', alias: ['first_name', 'first name', 'firstname', 'given name', 'first'] },
  { k: 'last_name', label: 'Last name', alias: ['last_name', 'last name', 'lastname', 'surname', 'last'] },
  { k: 'company', label: 'Company', alias: ['company', 'organization', 'organisation', 'org', 'firm', 'fund'] },
  { k: 'persona', label: 'Persona', alias: ['persona', 'type', 'category', 'role', 'contact type', 'segment'] },
  { k: 'context', label: 'Context', alias: ['context', 'note', 'notes', 'personal note', 'topic'] }
];

export type PersonaKey = 'Founder' | 'Investor' | 'Limited partner' | 'Advisor' | 'Operating partner' | 'General';

export interface Persona {
  key: PersonaKey;
  tone: string;
  /** Messages to this persona are held for partner approval. */
  approval: boolean;
}

export const PERSONAS: Persona[] = [
  { key: 'Founder', tone: 'direct and practical; what they get from it.', approval: false },
  { key: 'Investor', tone: 'concise, deal-flow framing; no performance claims.', approval: true },
  { key: 'Limited partner', tone: 'formal; states it is not about fund terms or capital activity.', approval: true },
  { key: 'Advisor', tone: 'collegial; asks for their involvement.', approval: false },
  { key: 'Operating partner', tone: 'peer to peer, operational.', approval: false },
  { key: 'General', tone: 'neutral institutional.', approval: false }
];

export const MAX_ROWS = 500;

export const OPTOUT_LINE =
  'You are receiving this as a contact of Axal VC. Reply "unsubscribe" and we will leave you out of future bulk emails.';

export const MERGE_TOKENS = ['{first_name}', '{last_name}', '{company|your team}', '{opening}'];

export function needsApproval(k: string): boolean {
  return !!PERSONAS.find(p => p.key === k)?.approval;
}

export function normPersona(v: string): PersonaKey {
  const x = (v || '').toLowerCase();
  if (!x) return 'General';
  if (/found|ceo|cto/.test(x)) return 'Founder';
  if (/\blp\b|limited/.test(x)) return 'Limited partner';
  if (/invest|angel|\bvc\b|capital/.test(x)) return 'Investor';
  if (/advis/.test(x)) return 'Advisor';
  if (/operat/.test(x)) return 'Operating partner';
  return 'General';
}

/** Map each field to the first header matching one of its aliases (-1 = not mapped). */
export function autoMap(headers: string[]): Record<BulkField['k'], number> {
  const map = {} as Record<BulkField['k'], number>;
  for (const f of BULK_FIELDS) map[f.k] = headers.findIndex(h => f.alias.includes(h.trim().toLowerCase()));
  return map;
}

export interface PersonaMessage {
  subject: string;
  body: string;
}

/** Offline persona templates used when no assistant backend is connected. */
export function writePersona(p: PersonaKey, brief: string): PersonaMessage {
  const short = brief.replace(/^the\s+/i, '').split(',')[0];
  const Short = short.charAt(0).toUpperCase() + short.slice(1);
  const C: Record<PersonaKey, [string, string]> = {
    Founder: ['Invitation: ' + Short, "Hi {first_name},\n\n{opening}We're hosting " + brief + ", and I'd like you to join us.\n\nIt's a good chance to meet the partners and operators who work with our portfolio day to day, and to get direct feedback on where {company|your company} is heading.\n\nIf you can make it, reply to this email and we'll hold a place for you.\n\nBest,"],
    Investor: [Short + ': a place for {company|your team}', "Hi {first_name},\n\n{opening}We're hosting " + brief + ". Founders from the current cohort will present, and we'd be glad to have {company|your team} in the room.\n\nWe'll share the list of presenting companies a week ahead so you can plan your time.\n\nLet me know if you'd like a place.\n\nBest regards,"],
    'Limited partner': ['Invitation: ' + Short, 'Dear {first_name},\n\n{opening}On behalf of Axal VC, I would like to invite you to ' + brief + '.\n\nThis is an informational invitation. It does not concern fund terms, performance or capital activity, which we will continue to cover in our regular LP reporting.\n\nPlease reply if you would like to attend.\n\nKind regards,'],
    Advisor: ['Would you join us? ' + Short, "Hi {first_name},\n\n{opening}We're hosting " + brief + '. Your perspective would help the founders presenting. Would you be open to joining, and possibly sitting in on one of the feedback sessions?\n\nThanks,'],
    'Operating partner': [Short + ' — would value you there', "Hi {first_name},\n\n{opening}We're hosting " + brief + ". Several of the presenting teams are working through hiring and go-to-market questions you know well, and I'd like you there to meet them.\n\nAny chance you can make it?\n\nBest,"],
    General: ['Invitation: ' + Short, 'Hello {first_name|there},\n\n{opening}You are invited to ' + brief + '.\n\nPlease reply to this email if you would like to attend.\n\nBest regards,']
  };
  const [subject, body] = C[p];
  return { subject, body };
}

export interface BulkRow {
  i: number;
  email: string;
  first: string;
  last: string;
  company: string;
  context: string;
  persona: PersonaKey;
  /** Persona as written in the CSV. */
  raw: string;
  status: 'ready' | 'internal' | 'duplicate' | 'invalid' | 'optout';
  hint: string;
  include: boolean;
}

/** Replace {field} and {field|fallback} tokens. Reports fields that were empty with no fallback. */
export function mergeTpl(tpl: string, r: Pick<BulkRow, 'first' | 'last' | 'company' | 'persona' | 'email' | 'context'>) {
  const missing: string[] = [];
  const vals: Record<string, string> = {
    first_name: r.first, last_name: r.last, company: r.company, persona: r.persona, email: r.email,
    opening: r.context ? 'Following up on ' + r.context + '. ' : ''
  };
  const text = (tpl || '').replace(/\{(\w+)(?:\|([^}]*))?\}/g, (m, k: string, fb?: string) => {
    if (!(k in vals)) { missing.push(k + ' (unknown field)'); return m; }
    if (vals[k]) return vals[k];
    if (fb != null) return fb;
    if (k !== 'opening') missing.push(k);
    return '';
  });
  return { text, missing };
}

export interface BulkRowInput {
  data: string[][];
  map: Record<string, number>;
  excluded: Record<number, boolean>;
  included: Record<number, boolean>;
  personaOv: Record<number, PersonaKey>;
  optOuts: Record<string, string>;
  /** Addresses on this domain are internal and excluded unless ticked. */
  orgDomain: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function bulkRows(b: BulkRowInput): BulkRow[] {
  const get = (r: string[], k: string) => (b.map[k] >= 0 ? (r[b.map[k]] || '').trim() : '');
  const seen: Record<string, number> = {};
  return b.data.map((r, i) => {
    const email = get(r, 'email').toLowerCase();
    let status: BulkRow['status'] = 'ready';
    let hint = '';
    if (!EMAIL_RE.test(email)) { status = 'invalid'; hint = email || 'No email'; }
    else if (seen[email] != null) { status = 'duplicate'; hint = 'Same as row ' + (seen[email] + 1); }
    else if (b.optOuts[email]) { status = 'optout'; hint = b.optOuts[email]; }
    else if (b.orgDomain && email.endsWith('@' + b.orgDomain)) { status = 'internal'; hint = 'Internal address'; }
    if (seen[email] == null) seen[email] = i;
    const raw = get(r, 'persona');
    const persona = b.personaOv[i] || normPersona(raw);
    const include = status === 'ready' ? !b.excluded[i] : status === 'internal' ? !!b.included[i] : false;
    return {
      i, email, first: get(r, 'first_name'), last: get(r, 'last_name'), company: get(r, 'company'),
      context: get(r, 'context'), persona, raw, status, hint, include
    };
  });
}

export function presentPersonas(inc: BulkRow[]): Persona[] {
  return PERSONAS.filter(p => inc.some(r => r.persona === p.key));
}
