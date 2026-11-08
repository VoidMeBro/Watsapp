const { createHash, randomUUID } = require('node:crypto');
const { mkdir, readdir, rename, rm, writeFile } = require('node:fs/promises');
const { join } = require('node:path');

const imageExtensions = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp'
};
const months = 'jan feb mar apr may jun jul aug sep oct nov dec'.split(' ');
const receiptMarker = /\b(?:receipt|invoice|subtotal|total|vat|gst|tax|tendered|cashier)\b/i;
const money = /\d+[.,]\d{2}\b/;
const storeFooter = /^thank you for shopping at\s+(\p{L}.*)$/iu;
const transactionDate = /\b(?:date|purchased|transaction|issued|sale)\b/i;
const otherDate = /\b(?:expir\w*|due date|valid (?:to|until)|return by|print(?:ed)? date)\b/i;
const datePattern = /\b(?:(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})|(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})|(\d{1,2})[\s-]+([a-z]{3,9})[\s,-]+(\d{4}|\d{2})|([a-z]{3,9})[\s-]+(\d{1,2})[\s,-]+(\d{4}|\d{2}))\b/gi;
const headerNoise = /^(?:welcome\b|thank\b|tel\b|phone\b|fax\b|www\.|https?:|vat\b|tax\b|receipt\b|invoice\b|cashier\b|till\b|transaction\b|register\b|date\b|time\b|branch\b|reg(?:istration)?\b|store\s*#)|\b(?:tax invoice|fiscal receipt|sales receipt|customer copy|merchant copy|cash sale|point of sale|cash receipt)\s*$/i;

function receiptDate(line) {
  for (const match of line.matchAll(datePattern)) {
    const [, isoYear, isoMonth, isoDay, first, second, numericYear,
      writtenDay, writtenMonth, writtenYear, monthFirst, daySecond, yearLast] = match;
    const yearText = isoYear || numericYear || writtenYear || yearLast;
    const year = Number(yearText) + (yearText.length === 2 ? 2000 : 0);
    const namedMonth = writtenMonth || monthFirst;
    const month = namedMonth ? months.indexOf(namedMonth.toLowerCase().slice(0, 3)) + 1
      : Number(isoMonth || (Number(second) > 12 ? first : second));
    const day = Number(isoDay || writtenDay || daySecond || (Number(second) > 12 ? second : first));
    const date = new Date(Date.UTC(year, month - 1, day));
    if (year >= 1900 && date.getUTCFullYear() === year &&
        date.getUTCMonth() + 1 === month && date.getUTCDate() === day) {
      return date.toISOString().slice(0, 10);
    }
  }
  return null;
}

function receiptDetails(text) {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!receiptMarker.test(text) || !lines.some(line => money.test(line) && !receiptDate(line))) return null;

  const dates = lines.filter(line => !otherDate.test(line));
  const date = dates.filter(line => transactionDate.test(line)).map(receiptDate).find(Boolean)
    || dates.map(receiptDate).find(Boolean);
  const headers = lines.slice(0, 8);
  const labeledStore = headers.find(line => /^(?:store|merchant|retailer)\s*:\s*\p{L}/iu.test(line));
  const footerStore = lines.map(line => line.match(storeFooter)).find(Boolean)?.[1];
  const store = labeledStore?.replace(/^[^:]+:\s*/, '') || footerStore || headers.find(line =>
    !headerNoise.test(line) && !receiptDate(line) && !money.test(line) &&
    /^\p{L}/u.test(line) && !/\b(?:street|road|avenue|mall|subtotal|total)\b|@/i.test(line));
  if (!date || !store) return null;

  const safeStore = store.normalize('NFC')
    .replace(/[^\p{L}\p{N}\p{M} &.'-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { date, store: Array.from(safeStore).slice(0, 60).join('').replace(/[ .]+$/, '') };
}

async function recognizeReceipt(worker, photo) {
  const { data } = await worker.recognize(photo, {}, { text: true, blocks: true });
  const lines = (data.blocks ?? []).flatMap(block => block.paragraphs)
    .flatMap(paragraph => paragraph.lines);
  const footer = lines.find(line => storeFooter.test(line.text.trim()));
  if (!footer) return data.text;

  const { x0, y0, x1, y1 } = footer.bbox;
  const left = Math.max(0, x0 - 10);
  const top = Math.max(0, y0 - 5);
  const { PSM } = require('tesseract.js');
  const { data: refined } = await worker.recognize(photo, {
    tessedit_pageseg_mode: PSM.SINGLE_LINE,
    rectangle: { left, top, width: x1 + 10 - left, height: y1 + 5 - top }
  });
  const line = refined.text.trim();
  if (refined.confidence >= footer.confidence && storeFooter.test(line)) {
    return data.text.replace(footer.text.trim(), line);
  }
  return data.text;
}

function createReceiptSaver(folder, recognize) {
  async function namePhoto(filename) {
    const source = join(folder, filename);
    const { id, extension } = /^pending-(?<id>[0-9a-f]{16})\.(?<extension>\w+)$/.exec(filename).groups;
    const details = receiptDetails(await recognize(source));
    const name = details?.store
      ? `${details.date} - ${details.store} - ${id}.${extension}`
      : `review-${id}.${extension}`;
    await rename(source, join(folder, name));
    return name;
  }

  return {
    async resume(onSaved, onError) {
      await mkdir(folder, { recursive: true });
      const files = await readdir(folder, { withFileTypes: true });
      for (const file of files) {
        if (!file.isFile() || !/^pending-[0-9a-f]{16}\.(?:jpg|png|webp)$/.test(file.name)) continue;
        try {
          onSaved(await namePhoto(file.name));
        } catch (error) {
          onError(error);
        }
      }
    },
    async save(messageId, downloadMedia) {
      if (typeof messageId !== 'string' || !messageId) throw new Error('WhatsApp did not provide a photo message ID.');
      const id = createHash('sha256').update(messageId).digest('hex').slice(0, 16);
      const savedPhoto = new RegExp(`(?:-| - )${id}\\.(?:jpg|png|webp)$`);
      const existing = (await readdir(folder)).find(filename =>
        savedPhoto.test(filename));
      if (existing) return existing.startsWith('pending-') ? namePhoto(existing) : null;

      const media = await downloadMedia();
      if (!media?.data) throw new Error('WhatsApp could not download the photo.');
      const extension = imageExtensions[media.mimetype.toLowerCase()];
      if (!extension) throw new Error('The photo format is unsupported.');

      const pending = `pending-${id}.${extension}`;
      const temp = join(folder, `.watsapp-${randomUUID()}.tmp`);
      try {
        await writeFile(temp, Buffer.from(media.data, 'base64'), { flag: 'wx' });
        await rename(temp, join(folder, pending));
      } finally {
        await rm(temp, { force: true });
      }
      return namePhoto(pending);
    }
  };
}

module.exports = { createReceiptSaver, receiptDetails, recognizeReceipt };
