const { createHash, randomUUID } = require('node:crypto');
const { readFile, readdir, rename, rm, writeFile } = require('node:fs/promises');
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
const storeLabel = /^(?:t\/a\s+|(?:store|merchant|retailer)\s*:\s*)(\p{L}.*)$/iu;
const transactionDate = /\b(?:date|purchased|transaction|issued|sale)\b/i;
const otherDate = /\b(?:expir\w*|due date|valid (?:to|until)|return by|print(?:ed)? date)\b/i;
const fullNumericDate = /\b(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{4})\b/;
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

function safeStoreName(store) {
  if (!store) return null;
  const safeStore = store.normalize('NFC')
    .replace(/[^\p{L}\p{N}\p{M} &.'-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(safeStore).slice(0, 60).join('').replace(/[ .]+$/, '') || null;
}

function receiptTotal(text) {
  const totals = new Set();
  for (const line of text.split(/\r?\n/)) {
    if (/\b(?:sub\s*total|exclusive|vat|tax|saving\w*|saved|discount|change)\b/i.test(line)) continue;
    if (!/^\s*(?:[^\w]*|[A-Z]{1,4}\s+)(?:(?:grand|invoice|inclusive invoice)\s+total|total\b|amount\s+(?:due|paid)|check[1\]]?(?=\s))/i.test(line)) continue;
    const amount = /(?:^|[\s:R])(\d{1,3}(?:,\d{3})+|\d+)\s*[.,]\s*(\d{2})\s*[A-Z|]*\s*$/i.exec(line);
    if (amount) totals.add(amount[1].replace(/,/g, '') + '.' + amount[2]);
  }
  return totals.size === 1 ? [...totals][0] : null;
}

async function recognizeTotal(worker, photo, text, width, height, mode) {
  const total = receiptTotal(text);
  if (total || !(width >= 100 && height >= 100)) return total;
  const votes = new Map();
  for (const [top, span, left, spanX] of [
    [.40, .10, .06, .69], [.46, .10, .06, .69],
    [.58, .05, .066, .603], [.59, .04, .066, .603],
    [.64, .10, .066, .603], [.70, .10, .066, .603]
  ]) {
    const { data } = await worker.recognize(photo, {
      tessedit_pageseg_mode: mode,
      rectangle: {
        left: Math.round(width * left), top: Math.round(height * top),
        width: Math.round(width * spanX), height: Math.round(height * span)
      }
    });
    const amount = receiptTotal(data.text);
    if (amount) votes.set(amount, (votes.get(amount) ?? 0) + 1);
  }
  const confirmed = [...votes].filter(([, count]) => count >= 2);
  return confirmed.length === 1 ? confirmed[0][0] : null;
}

async function recoverReceiptFields(worker, photo, width, height, details, total, alternateText) {
  const { PSM } = require('tesseract.js');
  async function read(left, top, right, bottom, mode = PSM.SINGLE_BLOCK) {
    const { data } = await worker.recognize(photo, {
      tessedit_pageseg_mode: mode,
      rectangle: {
        left: Math.round(width * left), top: Math.round(height * top),
        width: Math.round(width * (right - left)), height: Math.round(height * (bottom - top))
      }
    });
    return data.text;
  }
  let date = details?.date;
  let store = details?.store;
  const dates = new Set();
  const merchants = new Set();
  const totals = new Set();
  const logoNames = new Set();
  const headerVotes = new Map();
  function checkLogo(line) {
    const logo = line.replace(/[^a-z]/gi, '').toLowerCase();
    if (/^(?:[pbhg])?ickn[pf]ay$|^hcknpay$/.test(logo)) logoNames.add('Pick n Pay');
    if (logo === 'woolworths') logoNames.add('Woolworths');
  }
  for (const line of alternateText.split(/\r?\n/)) checkLogo(line);
  for (let band = 0; band < 16; band++) {
    const top = band * .06;
    const bottom = Math.min(1, top + .10);
    const text = await read(.12, top, .85, bottom);
    const headerNames = new Set();
    if (!total) {
      const amount = receiptTotal(text);
      if (amount) totals.add(amount);
    }
    for (const line of text.split(/\r?\n/)) {
      // Normalize common logo OCR variants alongside the generic merchant labels.
      checkLogo(line);
      const labeled = /\b(?:store|merchant|retailer|shop\s*name)\s*:\s*(\p{L}.*)$/iu.exec(line)?.[1];
      const name = safeStoreName(labeled || storeFooter.exec(line.trim())?.[1]);
      if (name) merchants.add(name);
      const header = line.trim();
      if (top <= .42 && /^(?:THE\s+)?[A-Z]{3,}(?:\s+[A-Z]{3,})+$/.test(header) &&
          !/\b(?:bank|retail|invoice|copy|discount|sale|gross|total articles|customer|road|street|avenue)\b/i.test(header)) {
        headerNames.add(header);
      }
      if (!date && !otherDate.test(line) && /\b\d{1,2}:\d{2}\b/.test(line)) {
        const candidate = receiptDate(line);
        if (candidate) dates.add(candidate);
      }
    }
    for (const name of headerNames) headerVotes.set(name, (headerVotes.get(name) ?? 0) + 1);
  }
  if (!date && dates.size === 0) {
    for (let band = 13; band < 16; band++) {
      const top = band * .06;
      const text = await read(.48, top, .82, Math.min(1, top + .10));
      for (const line of text.split(/\r?\n/)) {
        if (otherDate.test(line) || !/\b\d{1,2}:\d{2}\b/.test(line)) continue;
        const candidate = receiptDate(line);
        if (candidate) dates.add(candidate);
      }
    }
  }
  if (!date && dates.size === 0) {
    for (let band = 0; band < 15; band++) {
      const top = .80 + band * .012;
      const text = await read(.50, top, .76, Math.min(1, top + .033), PSM.SINGLE_LINE);
      if (otherDate.test(text) || !/\b\d{1,2}:\d{2}\b/.test(text)) continue;
      const candidate = receiptDate(text);
      if (candidate) dates.add(candidate);
    }
  }
  if (!date && dates.size === 1) [date] = dates;
  if (merchants.size === 1) [store] = merchants;
  else if (logoNames.size === 1) [store] = logoNames;
  else if (!reliableStore(store)) {
    const ranked = [...headerVotes].sort((a, b) => b[1] - a[1]);
    store = ranked[0]?.[1] >= 2 && ranked[0][1] > (ranked[1]?.[1] ?? 0) ? ranked[0][0] : null;
  }
  if (!total && totals.size === 1) [total] = totals;
  return date ? { ...details, date, store, ...(total ? { total } : {}) } : null;
}

function reliableStore(store) {
  return Boolean(store && /\p{L}{4}/u.test(store) &&
    !/\b(?:sale\s*&\s*re|whole\s*sale|retail|stadium$)/i.test(store));
}

function receiptDetails(text) {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!receiptMarker.test(text) || !lines.some(line => money.test(line) && !receiptDate(line))) return null;

  const dates = lines.filter(line => !otherDate.test(line));
  const timestampDate = dates.filter(line => /\b(?:timestamp|\d{1,2}:\d{2})\b/i.test(line))
    .map(line => line.match(fullNumericDate)?.[0]).filter(Boolean).map(receiptDate).find(Boolean);
  const date = timestampDate || dates.filter(line => transactionDate.test(line)).map(receiptDate).find(Boolean)
    || dates.map(receiptDate).find(Boolean);
  const headers = lines.slice(0, 8);
  const labeledStore = headers.map(line => line.match(storeLabel)).find(Boolean)?.[1];
  const footerStore = lines.map(line => line.match(storeFooter)).find(Boolean)?.[1];
  const store = labeledStore || footerStore || headers.find(line =>
    !headerNoise.test(line) && !receiptDate(line) && !money.test(line) &&
    /^\p{L}/u.test(line) && !/\b(?:street|road|avenue|mall|subtotal|total)\b|@/i.test(line));
  if (!date) return null;
  return { date, store: safeStoreName(store) };
}

async function readClippedDate(worker, photo, page, month, width, height, text) {
  const { PSM } = require('tesseract.js');
  const top = Math.ceil(height * 0.964);
  const { data } = await worker.recognize(photo, {
    tessedit_pageseg_mode: PSM.SPARSE_TEXT,
    rectangle: {
      left: Math.round(width * 0.29), top, width: Math.round(width * 0.37), height: height - top
    }
  }, { blocks: true });
  const words = (data.blocks ?? []).flatMap(block => block.paragraphs)
    .flatMap(paragraph => paragraph.lines).flatMap(line => line.words);
  const label = words.find(word => /^date$/i.test(word.text.trim()));
  if (!label) return null;
  const { x0, y0, y1 } = label.bbox;
  const textHeight = y1 - y0;
  const left = Math.max(0, x0 - Math.round(textHeight * 1.13));
  const dateTop = y0 + Math.round(textHeight * 0.57);
  const cropWidth = Math.min(width - left, Math.round(textHeight * 4.35));
  const cropHeight = height - dateTop;
  if (cropWidth < 3 || cropHeight < 3 || cropHeight > textHeight * 2) return null;

  // Stretch and deskew the clipped row for two independent contrast reads.
  const variants = await page.evaluate(async ({ image, left, top, width, height }) => {
    const source = await createImageBitmap(new Blob([Uint8Array.fromBase64(image)]));
    const crop = new OffscreenCanvas(width, height);
    const ctx = crop.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(source, left, top, width, height, 0, 0, width, height);
    source.close();
    const { data } = ctx.getImageData(0, 0, width, height);
    const levels = Uint8Array.from({ length: width * height }, (_, i) =>
      Math.round((data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2]) / 3));
    const median = levels.slice().sort()[Math.floor(levels.length / 2)];
    const crops = [];
    for (const offset of [22, 20]) {
      const scale = 4;
      const canvas = new OffscreenCanvas(width * scale + 30, height * scale + 132);
      const draw = canvas.getContext('2d');
      draw.fillStyle = 'white';
      draw.fillRect(0, 0, canvas.width, canvas.height);
      draw.translate(15, 65);
      draw.rotate(-10 * Math.PI / 180);
      draw.fillStyle = 'black';
      for (let i = 0; i < levels.length; i++) {
        if (levels[i] < median - offset) {
          draw.fillRect((i % width) * scale, Math.floor(i / width) * scale, scale, scale);
        }
      }
      const blob = await canvas.convertToBlob();
      crops.push(new Uint8Array(await blob.arrayBuffer()).toBase64());
    }
    return crops;
  }, { image: photo.toString('base64'), left, top: dateTop, width: cropWidth, height: cropHeight });

  let confirmedDay;
  for (const variant of variants) {
    const { data: reading } = await worker.recognize(Buffer.from(variant, 'base64'), {
      tessedit_pageseg_mode: PSM.SINGLE_LINE,
      tessedit_char_whitelist: '0123456789./-'
    });
    const day = /^(\d{2})[./-]?$/.exec(reading.text.trim())?.[1];
    if (!day || reading.confidence < 20 || (confirmedDay && day !== confirmedDay)) return null;
    confirmedDay = day;
  }
  const date = confirmedDay && receiptDate(`${month}-${confirmedDay}`);
  if (!date) return null;

  let store = text.split(/\r?\n/).map(line => line.trim().match(storeFooter)).find(Boolean)?.[1];
  const footerTop = y0 - textHeight * 6;
  const footerLeft = x0 - Math.round(textHeight * 0.91);
  if (!store && footerTop >= 0 && footerLeft >= 0) {
    const { data: footer } = await worker.recognize(photo, {
      tessedit_pageseg_mode: PSM.RAW_LINE,
      rectangle: {
        left: footerLeft, top: footerTop,
        width: Math.min(width - footerLeft, Math.round(textHeight * 6.43)),
        height: Math.round(textHeight * 1.9)
      }
    });
    const candidate = footer.text.trim().replace(/^\p{L}\s+/u, '');
    const merchant = candidate.match(/^(\p{L}[\p{L} &'-]+)\s+(\p{L}{3,})$/u);
    if (footer.confidence >= 55 && merchant &&
        text.split(/\W+/).some(word => word.toLowerCase() === merchant[2].toLowerCase())) {
      store = candidate;
    }
  }
  return { date, store: safeStoreName(store), inferred: true };
}

async function recognizeReceipt(worker, photo, { page, month } = {}) {
  const { PSM } = require('tesseract.js');
  let { data } = await worker.recognize(photo, {}, { text: true, blocks: true, tsv: true });
  let details = receiptDetails(data.text);
  let sparseText = '';
  const dimensions = data.tsv.split('\n', 1)[0].split('\t');
  const width = Number(dimensions[8]);
  const height = Number(dimensions[9]);
  if (!details?.store && width > 0 && height > 0) {
    // Try separated text and paper crops before attempting to infer a date.
    const passes = [
      { tessedit_pageseg_mode: PSM.SPARSE_TEXT },
      { tessedit_pageseg_mode: PSM.SINGLE_BLOCK, rectangle: {
        left: Math.round(width * 0.17), top: Math.round(height * 0.16),
        width: Math.round(width * 0.7), height: Math.round(height * 0.74)
      } },
      { tessedit_pageseg_mode: PSM.SINGLE_BLOCK, rectangle: {
        left: Math.round(width * 0.211), top: Math.round(height * 0.32),
        width: Math.round(width * 0.562), height: Math.round(height * 0.444)
      } }
    ];
    for (const options of passes) {
      const { data: alternate } = await worker.recognize(photo, options, { text: true, blocks: true });
      if (options.tessedit_pageseg_mode === PSM.SPARSE_TEXT) sparseText = alternate.text;
      const result = receiptDetails(alternate.text);
      if (result?.store || (!details && result)) {
        data = alternate;
        details = result;
      }
      if (details?.store) break;
    }
  }
  const lines = (data.blocks ?? []).flatMap(block => block.paragraphs)
    .flatMap(paragraph => paragraph.lines);
  const footer = lines.find(line => storeFooter.test(line.text.trim()));
  let text = data.text;
  if (footer) {
    const { x0, y0, x1, y1 } = footer.bbox;
    const left = Math.max(0, x0 - 10);
    const top = Math.max(0, y0 - 5);
    const { data: refined } = await worker.recognize(photo, {
      tessedit_pageseg_mode: PSM.SINGLE_LINE,
      rectangle: { left, top, width: x1 + 10 - left, height: y1 + 5 - top }
    });
    const line = refined.text.trim();
    if (refined.confidence >= footer.confidence && storeFooter.test(line)) {
      text = text.replace(footer.text.trim(), line);
    }
  }
  details = receiptDetails(text);
  if (!details && page && month && width >= 100 && height >= 100) {
    details = await readClippedDate(worker, photo, page, month, width, height, text);
  }
  const total = details
    ? await recognizeTotal(worker, photo, text, width, height, PSM.SINGLE_BLOCK)
    : receiptTotal(text);
  if (reliableStore(details?.store) && total) return { ...details, total };
  if (width >= 100 && height >= 100 && (page || details?.store)) {
    return recoverReceiptFields(worker, photo, width, height, details, total, sparseText);
  }
  return details;
}

async function createReceiptImporter(folder, recognize) {
  const files = await readdir(folder, { withFileTypes: true });
  const savedIds = new Map();
  const savedHashes = new Map();
  for (const file of files) {
    const match = /^(?:\d{4}-\d{2}-\d{2} - .+ - |review-)([0-9a-f]{16})\.(?:jpe?g|png|webp)$/i.exec(file.name);
    if (!file.isFile() || !match) continue;
    const bytes = await readFile(join(folder, file.name));
    const saved = { name: file.name, id: match[1] };
    savedIds.set(saved.id, saved);
    savedHashes.set(createHash('sha256').update(bytes).digest('hex'), saved);
  }
  return {
    async importPhoto(messageId, downloadMedia) {
      if (typeof messageId !== 'string' || !messageId) throw new Error('WhatsApp did not provide a photo message ID.');
      const id = createHash('sha256').update(messageId).digest('hex').slice(0, 16);
      let saved = savedIds.get(id);
      let bytes;
      let extension;
      if (saved) {
        bytes = await readFile(join(folder, saved.name));
        extension = saved.name.split('.').pop();
      } else {
        const media = await downloadMedia();
        if (!media?.data) throw new Error('WhatsApp could not download the photo.');
        extension = imageExtensions[media.mimetype.toLowerCase()];
        if (!extension) throw new Error('The photo format is unsupported.');
        bytes = Buffer.from(media.data, 'base64');
      }

      const contentId = createHash('sha256').update(bytes).digest('hex');
      saved ??= savedHashes.get(contentId);
      if (saved && / - R\d+\.\d{2} - /i.test(saved.name)) return { status: 'existing' };
      let details;
      try {
        details = await recognize(bytes);
      } catch {
        // Keep the original photo when OCR cannot process it.
      }

      const amount = details?.total ? 'R' + details.total : 'total-unknown';
      if (saved) {
        const prefix = /^(\d{4}-\d{2}-\d{2} - .+?) (?:- total-unknown )?- [0-9a-f]{16}\./i.exec(saved.name)?.[1];
        if (!details?.total || (!prefix && !details.store)) return { status: 'existing' };
        const label = /^(?:review-)| - total-unknown - /i.test(saved.name) && details.store
          ? [details.date, details.store].join(' - ')
          : prefix;
        const name = [label, amount, saved.id].join(' - ') + '.' + saved.name.split('.').pop();
        await rename(join(folder, saved.name), join(folder, name));
        saved.name = name;
        return { status: 'saved', name };
      }
      const name = details
        ? `${details.date} - ${details.store || 'store-unknown'} - ${amount} - ${id}.${extension}`
        : `review-${id}.${extension}`;
      const temp = join(folder, `.watsapp-${randomUUID()}.tmp`);
      try {
        await writeFile(temp, bytes, { flag: 'wx' });
        await rename(temp, join(folder, name));
      } finally {
        await rm(temp, { force: true });
      }
      saved = { name, id };
      savedIds.set(id, saved);
      savedHashes.set(contentId, saved);
      return { status: details?.store && details.total ? 'saved' : 'review', name, inferred: details?.inferred };
    }
  };
}

module.exports = { createReceiptImporter, receiptDetails, receiptTotal, recognizeReceipt };
