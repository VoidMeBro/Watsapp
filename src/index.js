const { mkdir } = require('node:fs/promises');
const { resolve } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { parseArgs } = require('node:util');
const { createReceiptSaver } = require('./receipt');

const usage = [
  'npm start -- --list-groups',
  'npm start -- --group <group name or ID> --folder <path> [--show-browser]'
].join('\n');

function logSaved(name) {
  console.log(name.startsWith('review-') ? `Needs review: ${name}` : `Saved: ${name}`);
}

async function findGroups(client, selection, signal) {
  const deadline = Date.now() + 30_000;
  while (!signal.aborted) {
    // Reading the chat list directly avoids fetching metadata for every chat.
    const groups = await client.pupPage.evaluate(target => {
      const chats = window.require('WAWebCollections').Chat.getModelsArray();
      const groups = [];
      for (const chat of chats) {
        const id = chat.id?._serialized ?? chat.id?.serialized;
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
  let queue = Promise.resolve();
  let receive;
  const logError = error => console.error(`Receipt processing failed: ${error.message ?? error}`);
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

    const saver = createReceiptSaver(folder, async photo => {
      if (!worker) {
        const { createWorker } = require('tesseract.js');
        const cachePath = resolve('.ocr-cache');
        await mkdir(cachePath, { recursive: true });
        worker = await createWorker('eng', 1, { cachePath, errorHandler: () => {} });
      }
      const { data } = await worker.recognize(photo);
      return data.text;
    });
    queue = saver.resume(logSaved, logError);
    receive = message => {
      const chatId = message.fromMe ? message.to : message.from;
      if (chatId !== group.id || message.type !== 'image' || !message.hasMedia) return;
      queue = queue.then(() => saver.save(message)).then(name => {
        if (name) logSaved(name);
      }).catch(logError);
    };
    client.on('message_create', receive);
    console.log(`Watching "${group.name}" and saving photos to ${folder}`);
    await stopped;
  } finally {
    if (receive) client.off('message_create', receive);
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
    await queue.catch(logError);
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
