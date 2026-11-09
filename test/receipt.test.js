const assert = require('node:assert/strict');
const { mkdtemp, readFile, readdir, rename, rmdir, unlink } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');
const { createReceiptImporter, receiptDetails, receiptTotal, recognizeReceipt } = require('../src/receipt');

const receipt = 'Fresh Market\nVAT INVOICE\nReturn by 07/12/2026\nDate: 5 Nov 2026\nTOTAL R49.99';

test('extracts the final total and rejects conflicting amounts', () => {
  assert.equal(receiptTotal('Subtotal 544.52\nExclusive Invoice Total 544.52\nInclusive Invoice Total : 626.20\nVAT 81.68'), '626.20');
  assert.equal(receiptTotal('CHECK] R1,179. 50'), '1179.50');
  assert.equal(receiptTotal('TOTAL R10.00\nAMOUNT PAID R20.00'), null);
});

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

test('retries separated text before interpreting a cropped short date', async () => {
  const worker = {
    async recognize(_photo, options, output) {
      if (output.tsv) return { data: { text: 'FANTASY', tsv: '1\t1\t0\t0\t0\t0\t0\t0\t899\t1599' } };
      assert.equal(options.tessedit_pageseg_mode, '11');
      return { data: { text: 'FANTASY\n2026/11/03\nVAT INCL\nTotal R179.50' } };
    }
  };
  assert.deepEqual(await recognizeReceipt(worker, Buffer.from('stand-in for a photo')), {
    date: '2026-11-03', store: 'FANTASY', total: '179.50'
  });
});

test('infers a clipped date only when both OCR reads agree on a valid day', async () => {
  const page = { evaluate: async () => ['YQ==', 'Yg=='] };
  const label = { text: 'Date', bbox: { x0: 416, y0: 1564, x1: 462, y1: 1587 } };
  const blocks = [{ paragraphs: [{ lines: [{ words: [label] }] }] }];
  function workerFor(days) {
    return {
      async recognize(_photo, options, output) {
        if (output?.tsv) return { data: { text: '', tsv: '1\t1\t0\t0\t0\t0\t0\t0\t899\t1599' } };
        if (options.tessedit_char_whitelist) return { data: { text: days.shift(), confidence: 40 } };
        return { data: { text: '', blocks: options.tessedit_pageseg_mode === '11' ? blocks : [] } };
      }
    };
  }
  const photo = Buffer.from('stand-in for a photo');
  const context = { page, month: '2026-11' };
  assert.deepEqual(await recognizeReceipt(workerFor(['06', '06']), photo, context), {
    date: '2026-11-06', store: null, inferred: true
  });
  assert.equal(await recognizeReceipt(workerFor(['06', '08']), photo, context), null);
  assert.equal(await recognizeReceipt(workerFor(['31', '31']), photo, context), null);
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
  const recognize = async () => ({ ...receiptDetails(receipt), total: '49.99' });
  const importer = await createReceiptImporter(folder, recognize);
  const saved = await importer.importPhoto('photo-1', downloadMedia);
  assert.equal(saved.status, 'saved');
  assert.match(saved.name, /^2026-11-05 - Fresh Market - R49\.99 - [0-9a-f]{16}\.png$/);
  assert.deepEqual(await readFile(join(folder, saved.name)), bytes);
  assert.deepEqual(await importer.importPhoto('photo-1', downloadMedia), { status: 'existing' });
  assert.deepEqual(await importer.importPhoto('forwarded-photo-1', downloadMedia), { status: 'existing' });
  assert.equal(downloads, 2);
  const oldName = saved.name.replace(' - R49.99', '');
  await rename(join(folder, saved.name), join(folder, oldName));
  const rerun = await createReceiptImporter(folder, recognize);
  assert.equal((await rerun.importPhoto('photo-1', downloadMedia)).name, saved.name);
  assert.equal(downloads, 2);

  const unreadable = await createReceiptImporter(folder, async () => null);
  const otherBytes = Buffer.from('another photo');
  const review = await unreadable.importPhoto('photo-2', async () => ({
    mimetype: 'image/png', data: otherBytes.toString('base64')
  }));
  assert.equal(review.status, 'review');
  assert.match(review.name, /^review-[0-9a-f]{16}\.png$/);
  assert.deepEqual(await readFile(join(folder, review.name)), otherBytes);
});
