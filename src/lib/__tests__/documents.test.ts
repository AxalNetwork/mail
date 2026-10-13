import { DEFAULT_CATEGORIES } from '../documents';
import { DriveNotConnected } from '../../providers/gmail/driveAuth';
import { fakeDocuments } from '../../components/__tests__/fakeDocuments';

const pdf = () => new Blob(['%PDF-1.4 deck'], { type: 'application/pdf' });
const attachment = (o = {}) => ({ mailbox: 'julian@axal.vc', threadId: 't1', messageId: '<m1@mail.example>', name: 'Deck.pdf', size: 13, mime: 'application/pdf', blob: vi.fn(async () => pdf()), ...o });

describe('Documents (mocked Drive, no database)', () => {
  it('connects: the signed-in account’s Drive only, and its folders are reused on reconnect', async () => {
    const f = fakeDocuments();
    const s = await f.docs.connect();
    expect(s.categories.map(c => c.name)).toEqual([...DEFAULT_CATEGORIES].sort((a, b) => a.localeCompare(b)));
    expect(s.categories.map(c => c.name)).toContain('One-pagers');
    expect(s.googleEmail).toBe('julian@axal.vc');
    const before = f.drive.files.size;
    await f.docs.connect();
    expect(f.drive.files.size).toBe(before); // no duplicate folders

    const other = fakeDocuments({ account: 'julian.personal@gmail.com' });
    await expect(other.docs.connect()).rejects.toThrow(/Connect the Drive of julian@axal\.vc/);
    expect(other.auth.disconnect).toHaveBeenCalled();
    expect(other.drive.folder).not.toHaveBeenCalled();
  });

  it('finds its folders again from Drive alone (a new browser, no stored settings)', async () => {
    const f = fakeDocuments();
    await f.docs.connect();
    await f.docs.addCategory('Board Decks');
    const fresh = new (f.docs.constructor as typeof import('../documents').Documents)(f.drive as never, f.auth, async () => 'julian@axal.vc');
    const s = await fresh.settings();
    expect(s?.categories.map(c => c.name)).toContain('Board Decks');
  });

  it('saves an attachment’s bytes once, with where it came from kept on the file', async () => {
    const f = fakeDocuments();
    await f.docs.connect();
    const a = attachment();
    const first = await f.docs.saveAttachment(a, 'Pitch Decks');
    expect(first.existing).toBe(false);
    expect(f.drive.upload).toHaveBeenCalledTimes(1);
    expect(await (f.drive.upload.mock.calls[0][0] as Blob).text()).toBe('%PDF-1.4 deck'); // the real bytes, not a link
    const props = f.drive.upload.mock.calls[0][3] as Record<string, string>;
    // App properties are limited to 124 bytes: long ids are stored hashed.
    expect(Object.values(props).every(v => v.length <= 100)).toBe(true);
    expect(first.record).toMatchObject({ category: 'Pitch Decks', source: { threadId: 't1', mailbox: 'julian@axal.vc' } });
    const again = await f.docs.saveAttachment(a, 'Due Diligence');
    expect(again).toMatchObject({ existing: true, record: { id: first.record.id } });
    expect(f.drive.upload).toHaveBeenCalledTimes(1);
    // The reader finds what was saved from this message.
    expect((await f.docs.savedFrom('<m1@mail.example>')).map(r => [r.name, r.source?.messageId])).toEqual([['Deck.pdf', '<m1@mail.example>']]);
    // Trashed in Drive since: it is saved again.
    f.drive.files.get(first.record.driveFileId)!.trashed = true;
    await f.docs.saveAttachment(a, 'Pitch Decks');
    expect(f.drive.upload).toHaveBeenCalledTimes(2);
  });

  it('lists what Drive has now: renames and moves show, trashed files disappear', async () => {
    const f = fakeDocuments();
    const s = await f.docs.connect();
    const memo = await f.docs.upload(new Blob(['memo'], { type: 'text/plain' }), 'memo.txt', 'Investment Memoranda');
    const deck = await f.docs.upload(pdf(), 'deck.pdf', 'Pitch Decks');
    f.drive.files.get(memo.file.id)!.name = 'Northstar memo.txt';
    f.drive.files.get(memo.file.id)!.parents = [s.categories.find(c => c.name === 'Due Diligence')!.folderId];
    f.drive.files.get(deck.file.id)!.trashed = true;
    const l = await f.docs.list();
    expect(l.entries.map(e => [e.file.name, e.category, e.record?.name])).toEqual([['Northstar memo.txt', 'Due Diligence', 'Northstar memo.txt']]);
    expect(l.missing).toEqual([]);
  });

  it('renames, moves and trashes in Drive', async () => {
    const f = fakeDocuments();
    await f.docs.connect();
    const e = await f.docs.upload(pdf(), 'deck.pdf', 'Pitch Decks');
    await f.docs.rename(e, '  Final deck.pdf ');
    expect(f.drive.files.get(e.file.id)!.name).toBe('Final deck.pdf');
    await f.docs.move(e, 'Due Diligence');
    expect((await f.docs.list()).entries[0]).toMatchObject({ category: 'Due Diligence' });
    await f.docs.remove(e);
    expect(f.drive.trash).toHaveBeenCalledWith(e.file.id);
    expect((await f.docs.list()).entries).toEqual([]);
  });

  it('analyzes from Drive and keeps the result in Drive: PDFs as base64, text as text, others refused', async () => {
    const f = fakeDocuments();
    await f.docs.connect();
    const deck = await f.docs.upload(pdf(), 'deck.pdf', 'Pitch Decks');
    const r = await f.docs.analyze(deck);
    expect(f.extract).toHaveBeenLastCalledWith({ mimeType: 'application/pdf', name: 'deck.pdf', data: btoa('%PDF-1.4 deck') });
    expect(r.extraction).toMatchObject({ status: 'done', result: { summary: 'Seed deck.' } });
    // Read back from Drive on the next list, and replaced (not duplicated) by a second analysis.
    expect((await f.docs.list()).entries[0].record?.extraction).toMatchObject({ status: 'done', result: { summary: 'Seed deck.' } });
    await f.docs.analyze(deck);
    const sidecars = [...f.drive.files.values()].filter(x => x.appProperties?.axalExtractionFor === deck.file.id && !x.trashed);
    expect(sidecars).toHaveLength(1);
    // Not a document: the results folder isn't listed as a category.
    expect((await f.docs.settings())?.categories.map(c => c.name)).not.toContain('AI extractions');

    const memo = await f.docs.upload(new Blob(['ARR $1M'], { type: 'text/plain' }), 'memo.txt', 'Investment Memoranda');
    await f.docs.analyze(memo);
    expect(f.extract).toHaveBeenLastCalledWith({ mimeType: 'text/plain', name: 'memo.txt', text: 'ARR $1M' });
    f.extract.mockRejectedValueOnce(new Error('The assistant declined this request.'));
    expect((await f.docs.analyze(memo)).extraction).toMatchObject({ status: 'failed', result: { error: 'The assistant declined this request.' } });
    const img = await f.docs.upload(new Blob(['x'], { type: 'image/png' }), 'x.png', 'General Documents');
    await expect(f.docs.analyze(img)).rejects.toThrow(/supports PDF and plain text/);
  });

  it('gives a file’s bytes to attach; Google Docs files as PDF', async () => {
    const f = fakeDocuments();
    await f.docs.connect();
    const deck = await f.docs.upload(pdf(), 'One-pager.pdf', 'One-pagers');
    expect(await f.docs.file(deck)).toMatchObject({ name: 'One-pager.pdf', mime: 'application/pdf' });
    const doc = { ...deck, file: { ...deck.file, name: 'Fund one-pager', mimeType: 'application/vnd.google-apps.document' } };
    const out = await f.docs.file(doc);
    expect(out).toMatchObject({ name: 'Fund one-pager.pdf', mime: 'application/pdf' });
    expect(f.drive.exportPdf).toHaveBeenCalledWith(deck.file.id);
  });

  it('needs a connection, and reports a revoked one', async () => {
    const f = fakeDocuments();
    await expect(f.docs.list()).rejects.toBeInstanceOf(DriveNotConnected);
    await f.docs.connect();
    f.drive.revoked = true;
    (f.docs as unknown as { cached: null }).cached = null;
    await expect(f.docs.list()).rejects.toThrow(/Reconnect Google Drive/);
  });
});
