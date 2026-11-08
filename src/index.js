const { mkdir } = require('node:fs/promises');
const { resolve } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { parseArgs } = require('node:util');
const { createReceiptImporter, recognizeReceipt } = require('./receipt');
const { downloadPhoto, loadPhotoIds } = require('./whatsapp');

const usage = [
  'npm start -- --list-groups',
  'npm start -- --group <group name or ID> --folder <path> [--show-browser]'
].join('\n');

async function findGroups(client, selection, signal) {
  const deadline = Date.now() + 30_000;
  while (!signal.aborted) {
    // Reading the chat list directly avoids fetching metadata for every chat.
    const groups = await client.pupPage.evaluate(target => {
      const chats = window.require('WAWebCollections').Chat.getModelsArray();
      const groups = [];
      for (const chat of chats) {
        const id = chat.id?._serialized ?? chat.id?.serialized ?? chat.id?.$1;
        if (typeof id !== 'string' || !id.endsWith('@g.us')) continue;
        const name = chat.formattedTitle;
        if (!target || target === id || target === name) groups.push({ id, name });
      }
      return groups;
    }, selection);
    if (groups.length || Date.now() >= deadline) return groups;
    await delay(2_000);
  }
  return [];
}

async function main() {
  const { values } = parseArgs({
    options: {
      'list-groups': { type: 'boolean' },
      'show-browser': { type: 'boolean' },
      group: { type: 'string' },
      folder: { type: 'string' },
      help: { type: 'boolean', short: 'h' }
    }
  });
  if (values.help) {
    console.log(usage);
    return;
  }
  const listGroups = values['list-groups'];
  const groupNameOrId = values.group?.trim();
  if (listGroups ? values.group || values.folder : !groupNameOrId || !values.folder?.trim()) {
    throw new Error(usage);
  }

  const folder = listGroups ? null : resolve(values.folder);
  if (folder) await mkdir(folder, { recursive: true });
  const { Client, LocalAuth } = require('whatsapp-web.js');
  const showBrowser = values['show-browser'];
  const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { headless: !showBrowser }
  });
  client.on('qr', code => {
    console.log('On your phone, open WhatsApp > Linked devices > Link a device.');
    if (showBrowser) console.log('Scan the QR code in the WhatsApp Web window.');
    else require('qrcode-terminal').generate(code, { small: true });
  });

  let worker;
  const stop = new AbortController();
  const interrupt = () => stop.abort();
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  client.once('disconnected', reason => {
    console.error(`WhatsApp disconnected: ${reason}. Restart Watsapp to reconnect.`);
    process.exitCode = 1;
    interrupt();
  });

  const stopped = new Promise(resolve => stop.signal.addEventListener('abort', resolve, { once: true }));
  try {
    const ready = new Promise((resolve, reject) => {
      client.once('ready', resolve);
      client.once('auth_failure', () => reject(new Error('WhatsApp authentication failed.')));
    });
    await Promise.race([Promise.all([client.initialize(), ready]), stopped]);
    if (stop.signal.aborted) return;

    console.log('WhatsApp linked. Waiting for the chat list.');
    const groups = await findGroups(client, listGroups ? null : groupNameOrId, stop.signal);
    if (stop.signal.aborted) return;
    if (listGroups) {
      for (const group of groups) console.log(`${group.id}\t${group.name}`);
      return;
    }
    if (groups.length > 1) throw new Error('More than one group has that name. Use --list-groups to find its ID.');
    const [group] = groups;
    if (!group) throw new Error('Group not found. Run with --list-groups to check its name or ID.');

    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    console.log(`Loading image history from "${group.name}" for receipts dated ${month}.`);
    const { photos, missingIds } = await Promise.race([
      loadPhotoIds(client.pupPage, group.id),
      stopped.then(() => ({ photos: [], missingIds: 0 }))
    ]);
    if (stop.signal.aborted) return;
    console.log(`Checking ${photos.length} available images.`);

    const importer = await createReceiptImporter(folder, month, async photo => {
      if (!worker) {
        const { createWorker } = require('tesseract.js');
        const cachePath = resolve('.ocr-cache');
        await mkdir(cachePath, { recursive: true });
        worker = await createWorker('eng', 1, { cachePath, errorHandler: () => {} });
      }
      return recognizeReceipt(worker, photo);
    });
    const counts = { saved: 0, existing: 0, outsideMonth: 0, unreadable: 0, failed: missingIds };
    const failures = new Map();
    for (const [index, id] of photos.entries()) {
      if (stop.signal.aborted) break;
      if (index > 0 && index % 10 === 0) console.log(`Checked ${index} of ${photos.length} images.`);
      try {
        const { status, name } = await importer.importPhoto(id, () => downloadPhoto(client.pupPage, id));
        counts[status]++;
        if (name) console.log(`Saved: ${name}`);
      } catch (error) {
        counts.failed++;
        const reason = error.message ?? String(error);
        failures.set(reason, (failures.get(reason) ?? 0) + 1);
      }
    }
    console.log(`Imported ${counts.saved}; already saved ${counts.existing}; outside month ${counts.outsideMonth}; unreadable ${counts.unreadable}; failed ${counts.failed}.`);
    if (missingIds) console.error(`${missingIds} photos had no WhatsApp message ID.`);
    for (const [reason, count] of failures) console.error(`${count} failed: ${reason}`);
    if (counts.failed) process.exitCode = 1;
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
    if (worker) await worker.terminate();
    const browser = client.pupBrowser;
    // whatsapp-web.js still checks isConnected(), which Puppeteer 25 removed.
    if (browser?.connected && typeof browser.isConnected !== 'function') await browser.close();
    if (browser) await client.destroy();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
