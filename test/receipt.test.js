const assert = require('node:assert/strict');
const { mkdtemp, readFile, readdir, rmdir, unlink } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');
const { createReceiptSaver, receiptDetails } = require('../src/receipt');

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

test('preserves photos through OCR failure and deduplicates successfully named photos', async t => {
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
  const failingSaver = createReceiptSaver(folder, async () => { throw new Error('OCR failed'); });
  await assert.rejects(failingSaver.save('photo-1', downloadMedia), /OCR failed/);
  assert.match((await readdir(folder))[0], /^pending-/);

  const saver = createReceiptSaver(folder, async () => receipt);
  const saved = [];
  await saver.resume(name => saved.push(name), assert.fail);
  assert.match(saved[0], /^2026-11-05 - Fresh Market - [0-9a-f]{16}\.png$/);
  assert.deepEqual(await readFile(join(folder, saved[0])), bytes);
  assert.equal(await saver.save('photo-1', downloadMedia), null);
  assert.equal(downloads, 1);
});
