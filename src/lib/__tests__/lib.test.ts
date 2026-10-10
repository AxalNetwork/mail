import { parseCSV } from '../csv';
import { autoMap, bulkRows, mergeTpl, normPersona, presentPersonas } from '../bulk';
import { parseAddressList, parsePerson, sendChecks } from '../compose';
import { base64ToBytes, buildMime, encodeHeader } from '../mime';
import { signatureHtml, signatureText } from '../signature';
import { assembleHtml, extractBody } from '../outgoing';
import { htmlToText, textToHtml } from '../html';
import { listTime, messageTime } from '../format';
import { SAMPLE_CSV, OPT_OUTS, IDENTITIES, PROFILES } from '../../providers/demo/data';

describe('parseCSV', () => {
  it('handles quotes, escaped quotes, CRLF and blank rows', () => {
    expect(parseCSV('a,b\r\n"x, y","say ""hi"""\n\n1,\n')).toEqual([['a', 'b'], ['x, y', 'say "hi"'], ['1', '']]);
  });
});

describe('bulk', () => {
  const parsed = parseCSV(SAMPLE_CSV);
  const headers = parsed[0];
  const rows = bulkRows({ data: parsed.slice(1), map: autoMap(headers), excluded: {}, included: {}, personaOv: {}, optOuts: OPT_OUTS, orgDomain: 'axal.vc' });

  it('maps columns by alias', () => {
    expect(autoMap(['E-mail', 'First Name', 'Organisation'])).toMatchObject({ email: 0, first_name: 1, company: 2, persona: -1 });
  });

  it('classifies rows like the prototype', () => {
    const by = (s: string) => rows.filter(r => r.status === s).length;
    expect([by('ready'), by('duplicate'), by('invalid'), by('optout'), by('internal')]).toEqual([7, 1, 1, 1, 1]);
    expect(rows.filter(r => r.include)).toHaveLength(7);
    expect(rows.find(r => r.email.startsWith('raj'))!.persona).toBe('Limited partner');
    expect(rows.find(r => r.email.startsWith('chris'))!.persona).toBe('Investor');
    expect(presentPersonas(rows.filter(r => r.include)).map(p => p.key)).toEqual(['Founder', 'Investor', 'Limited partner', 'Advisor', 'Operating partner']);
  });

  it('normalises personas', () => {
    expect(normPersona('CTO')).toBe('Founder');
    expect(normPersona('')).toBe('General');
    expect(normPersona('family office')).toBe('General');
  });

  it('merges tokens with fallbacks and reports missing fields', () => {
    const r = { first: 'Chris', last: '', company: '', persona: 'Investor' as const, email: 'c@x.example', context: 'the Q3 update' };
    const m = mergeTpl('Hi {first_name} {last_name}, {opening}for {company|your team}. {bogus}', r);
    expect(m.text).toBe('Hi Chris , Following up on the Q3 update. for your team. {bogus}');
    expect(m.missing).toEqual(['last_name', 'bogus (unknown field)']);
  });
});

describe('addresses', () => {
  it('parses names, angle addresses and invalid input', () => {
    expect(parsePerson('"Park, Julian" <julian@axal.vc>')).toEqual({ name: 'Park, Julian', email: 'julian@axal.vc', org: 'axal.vc', invalid: false });
    expect(parsePerson('nope@')).toMatchObject({ invalid: true });
  });
  it('splits address headers without breaking quoted commas', () => {
    expect(parseAddressList('"Park, Julian" <julian@axal.vc>, bob@b.example').map(p => p.email)).toEqual(['julian@axal.vc', 'bob@b.example']);
  });
});

describe('sendChecks', () => {
  const base = {
    identity: IDENTITIES[0], defaultIdentityId: 'me', to: [{ name: 'D', email: 'd@meridian.example', org: '' }], cc: [], bcc: [],
    subject: 'Hello', text: '', attachments: [], orgDomain: 'axal.vc'
  };
  it('is quiet for a plain external message', () => expect(sendChecks(base)).toEqual([]));
  it('flags fund terms, confidential files and send-as', () => {
    const r = sendChecks({
      ...base, identity: IDENTITIES[1], subject: 'Term sheet',
      attachments: [{ id: '1', name: 'deck.pdf', ext: 'PDF', size: 1, mime: '', cls: 'Confidential', secure: true, source: { kind: 'doc', docId: 'd1' } }]
    });
    expect(r).toHaveLength(3);
  });
  it('ignores fund terms when everyone is internal', () => {
    expect(sendChecks({ ...base, to: [{ name: 'P', email: 'priya@axal.vc', org: '' }], subject: 'term sheet' })).toEqual([]);
  });
});

describe('buildMime', () => {
  const raw = buildMime({
    from: { name: 'Julian Park', email: 'julian@axal.vc', org: '' }, to: [{ name: 'Zoë', email: 'zoe@x.example', org: '' }], cc: [], bcc: [{ name: 'b@x.example', email: 'b@x.example', org: '' }],
    subject: 'Café ☕', html: '<p>Hé</p>', text: 'Hé', priority: 'High', inReplyTo: '<a@x>', references: '<root@x>',
    attachments: [{ name: 'a.txt', mime: 'text/plain', data: new TextEncoder().encode('hello') }], boundarySeed: 'T', date: new Date(0)
  });
  it('writes encoded headers and threading headers', () => {
    expect(raw).toContain('Subject: ' + encodeHeader('Café ☕'));
    expect(raw).toContain('To: =?UTF-8?B?');
    expect(raw).toContain('Bcc: b@x.example');
    expect(raw).toContain('In-Reply-To: <a@x>');
    expect(raw).toContain('References: <root@x> <a@x>');
    expect(raw).toContain('X-Priority: 1');
  });
  it('nests alternative inside mixed and base64-encodes parts', () => {
    expect(raw).toContain('multipart/mixed; boundary="=_axal_T_0"');
    expect(raw).toContain('multipart/alternative; boundary="=_axal_T_1"');
    expect(raw).toContain('filename="a.txt"');
    const att = raw.split('filename="a.txt"')[1].split('\r\n\r\n')[1].split('\r\n')[0];
    expect(new TextDecoder().decode(base64ToBytes(att))).toBe('hello');
    expect(raw.split('\r\n').every(l => l.length <= 998)).toBe(true);
  });
});

describe('signature', () => {
  it('leaves out missing lines and escapes values', () => {
    const p = { ...PROFILES[3], title: '<b>Admin</b>' };
    const html = signatureHtml(p);
    expect(html).not.toContain('REGION');
    expect(html).not.toContain('LINKEDIN');
    expect(html).toContain('WHATSAPP');
    expect(html).toContain('&lt;b&gt;Admin');
    expect(html).toContain('<img src="https://mail.axal.vc/logo.png" alt="Axal VC"');
    expect(signatureText(PROFILES[0])).toContain('WhatsApp: +1 212 555 0148');
  });
});

describe('outgoing', () => {
  it('round-trips the editable body out of an assembled message', () => {
    const html = assembleHtml('<p>Body</p>', '<table><tr><td>sig</td></tr></table>', { who: 'Maya', time: 'Today', text: 'hi' }, 'opt out');
    expect(extractBody(html)).toBe('<p>Body</p>');
    expect(extractBody('<p>Plain</p><div class="axal-signature">x</div>')).toBe('<p>Plain</p>');
  });
  it('converts between text and html', () => {
    expect(textToHtml('a\nb\n\n<c>')).toBe('<p>a<br>b</p><p>&lt;c&gt;</p>');
    expect(htmlToText('<p>One</p><ul><li>Two</li></ul>')).toBe('One\n• Two');
  });
});

describe('format', () => {
  const now = new Date(2026, 9, 9, 15, 0);
  it('formats list and message times', () => {
    expect(listTime(new Date(2026, 9, 9, 9, 42).getTime(), now)).toBe('09:42');
    expect(listTime(new Date(2026, 9, 8, 16, 20).getTime(), now)).toBe('Yesterday');
    expect(listTime(new Date(2026, 9, 6, 11, 5).getTime(), now)).toBe('Tue');
    expect(listTime(new Date(2026, 9, 1).getTime(), now)).toBe('1 Oct');
    expect(listTime(new Date(2025, 9, 1).getTime(), now)).toBe('1 Oct 2025');
    expect(messageTime(new Date(2026, 9, 9, 9, 42).getTime(), now)).toBe('Today 09:42');
  });
});
