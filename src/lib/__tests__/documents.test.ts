import { DEFAULT_CATEGORIES } from '../documents';
import { DriveNotConnected } from '../../providers/gmail/driveAuth';
import { fakeDocuments } from '../../components/__tests__/fakeDocuments';

const pdf = () => new Blob(['%PDF-1.4 deck'], { type: 'application/pdf' });
const attachment = (o = {}) => ({ mailbox: 'julian@axal.vc', threadId: 't1', messageId: 'm1', name: 'Deck.pdf', size: 13, mime: 'application/pdf', blob: vi.fn(async () => pdf()), ...o });

describe('Documents (mocked Drive)', () => {
  it('connects: the signed-in account’s Drive only, and its folders are reused on reconnect', async () => {
    const f = fakeDocuments();
    const s = await f.docs.connect();
    expect(s.categories.map(c => c.name)).toEqual(DEFAULT_CATEGORIES);
    expect(s.googleEmail).toBe('julian@axal.vc');
    const before = f.drive.files.size;
    await f.docs.connect();
    expect(f.drive.files.size).toBe(before); // no duplicate folders

    const other = fakeDocuments({ account: 'julian.personal@gmail.com' });
    await expect(other.docs.connect()).rejects.toThrow(/Connect the Drive of julian@axal\.vc/);
    expect(other.auth.disconnect).toHaveBeenCalled();
    expect(other.backend.saveSettings).not.toHaveBeenCalled();
  });

  it('saves an attachment’s bytes once, however often it is saved', async () => {
    const f = fakeDocuments();
    await f.docs.connect();
    const a = attachment();
    const first = await f.docs.saveAttachment(a, 'Pitch Decks');
    expect(first.existing).toBe(false);
    expect(f.drive.upload).toHaveBeenCalledTimes(1);
    expect(await (f.drive.upload.mock.calls[0][0] as Blob).text()).toBe('%PDF-1.4 deck'); // the real bytes, not a link
    expect(first.record).toMatchObject({ category: 'Pitch Decks', source: { threadId: 't1', messageId: 'm1' } });
    const again = await f.docs.saveAttachment(a, 'Due Diligence');
    expect(again).toMatchObject({ existing: true, record: { id: first.record.id } });
    expect(f.drive.upload).toHaveBeenCalledTimes(1);

    // Its record lost (e.g. a failed write after the upload): Drive's tag finds the copy.
    f.backend.rows.length = 0;
    const third = await f.docs.saveAttachment(a, 'Pitch Decks');
    expect(third.existing).toBe(true);
    expect(f.drive.upload).toHaveBeenCalledTimes(1);
    // Trashed in Drive since: it is saved again.
    f.drive.files.get(third.record.driveFileId)!.trashed = true;
    await f.docs.saveAttachment(a, 'Pitch Decks');
    expect(f.drive.upload).toHaveBeenCalledTimes(2);
  });

  it('follows Drive: renames and moves update records, deleted files are listed as missing', async () => {
    const f = fakeDocuments();
    const s = await f.docs.connect();
    const memo = await f.docs.upload(new Blob(['memo'], { type: 'text/plain' }), 'memo.txt', 'Investment Memoranda');
    const deck = await f.docs.upload(pdf(), 'deck.pdf', 'Pitch Decks');
    // Changed directly in Drive:
    f.drive.files.get(memo.file.id)!.name = 'Northstar memo.txt';
    f.drive.files.get(memo.file.id)!.parents = [s.categories.find(c => c.name === 'Due Diligence')!.folderId];
    f.drive.files.get(deck.file.id)!.trashed = true;
    const l = await f.docs.list();
    expect(l.entries.map(e => [e.file.name, e.category, e.record?.name])).toEqual([['Northstar memo.txt', 'Due Diligence', 'Northstar memo.txt']]);
    expect(l.missing.map(r => [r.name, r.missing])).toEqual([['deck.pdf', true]]);
    await f.docs.forget(l.missing[0]);
    expect((await f.docs.list()).missing).toEqual([]);
  });

  it('renames, moves and trashes in Drive, then updates the record', async () => {
    const f = fakeDocuments();
    await f.docs.connect();
    const e = await f.docs.upload(pdf(), 'deck.pdf', 'Pitch Decks');
    await f.docs.rename(e, '  Final deck.pdf ');
    expect(f.drive.files.get(e.file.id)!.name).toBe('Final deck.pdf');
    await f.docs.move(e, 'Due Diligence');
    expect(f.backend.rows[0]).toMatchObject({ name: 'Final deck.pdf', category: 'Due Diligence' });
    await f.docs.remove(e);
    expect(f.drive.trash).toHaveBeenCalledWith(e.file.id);
    expect(f.backend.rows).toEqual([]);
  });

  it('reads the file from Drive for analysis: PDFs as base64, text as text, others refused', async () => {
    const f = fakeDocuments();
    await f.docs.connect();
    const deck = await f.docs.upload(pdf(), 'deck.pdf', 'Pitch Decks');
    await f.docs.analyze(deck);
    expect(f.backend.analyze).toHaveBeenLastCalledWith(deck.record!.id, { mimeType: 'application/pdf', data: btoa('%PDF-1.4 deck') });
    const memo = await f.docs.upload(new Blob(['ARR $1M'], { type: 'text/plain' }), 'memo.txt', 'Investment Memoranda');
    await f.docs.analyze(memo);
    expect(f.backend.analyze).toHaveBeenLastCalledWith(memo.record!.id, { mimeType: 'text/plain', text: 'ARR $1M' });
    const img = await f.docs.upload(new Blob(['x'], { type: 'image/png' }), 'x.png', 'General Documents');
    await expect(f.docs.analyze(img)).rejects.toThrow(/supports PDF and plain text/);
  });

  it('needs a connection, and reports a revoked one', async () => {
    const f = fakeDocuments();
    await expect(f.docs.list()).rejects.toBeInstanceOf(DriveNotConnected);
    await f.docs.connect();
    f.drive.revoked = true;
    await expect(f.docs.list()).rejects.toThrow(/Reconnect Google Drive/);
  });
});
