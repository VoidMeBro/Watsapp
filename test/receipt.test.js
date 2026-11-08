const assert = require('node:assert/strict');
const { mkdtemp, readFile, readdir, rmdir, unlink } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');
const { createReceiptImporter, receiptDetails } = require('../src/receipt');

const receipt = 'Fresh Market\nVAT INVOICE\nReturn by 07/12/2026\nDate: 5 Nov 2026\nTOTAL R49.99';

test('extracts the transaction date and ignores invalid dates and unrelated text', () => {
  assert.deepEqual(receiptDetails(receipt), { date: '2026-11-05', store: 'Fresh Market' });
  assert.equal(receiptDetails('Market\nINVOICE\nDate: 31/02/2026\nTotal R39.20'), null);
  assert.equal(receiptDetails('Portrait\n5 November 2026'), null);
});

test('uses the merchant named in the receipt footer when the header is unclear', () => {
  const text = 'Summerstrand 04 122\nTAX INVOICE\nTOTAL R49.99\nThank you for shopping at Pick n Pay.\n07.11.26';
  assert.deepEqual(receiptDetails(text), { date: '2026-11-07', store: 'Pick n Pay' });
});

test('prefers a full transaction timestamp over an ambiguous short date', () => {
  const text = 'TAX INVOICE\nt/a TOTAL Summerstrand\nTotal R390.00\nDate: 26/11/08 14:08\nEdison Timestamp: 08/11/2026 02:08 PM';
  assert.deepEqual(receiptDetails(text), { date: '2026-11-08', store: 'TOTAL Summerstrand' });
});

test('uses the printed date for naming and skips existing photos', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'watsapp-test-'));
  t.after(async () => {
    for (const file of await readdir(folder)) await unlink(join(folder, file));
    await rmdir(folder);
  });
  const bytes = Buffer.from('stand-in for a photo');
  let downloads = 0;
  const downloadMedia = async () => {
    downloads++;
    return { mimetype: 'image/png', data: bytes.toString('base64') };
  };
  const importer = await createReceiptImporter(folder, async () => receipt);
  const saved = await importer.importPhoto('photo-1', downloadMedia);
  assert.equal(saved.status, 'saved');
  assert.match(saved.name, /^2026-11-05 - Fresh Market - [0-9a-f]{16}\.png$/);
  assert.deepEqual(await readFile(join(folder, saved.name)), bytes);
  assert.deepEqual(await importer.importPhoto('photo-1', downloadMedia), { status: 'existing' });
  assert.deepEqual(await importer.importPhoto('forwarded-photo-1', downloadMedia), { status: 'existing' });
  assert.equal(downloads, 2);

  const unreadable = await createReceiptImporter(folder, async () => 'Unreadable photo');
  const otherBytes = Buffer.from('another photo');
  const review = await unreadable.importPhoto('photo-2', async () => ({
    mimetype: 'image/png', data: otherBytes.toString('base64')
  }));
  assert.equal(review.status, 'review');
  assert.match(review.name, /^review-[0-9a-f]{16}\.png$/);
  assert.deepEqual(await readFile(join(folder, review.name)), otherBytes);
});
