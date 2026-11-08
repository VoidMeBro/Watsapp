const { mkdir } = require('node:fs/promises');
const { resolve } = require('node:path');
const { parseArgs } = require('node:util');
const { createReceiptSaver } = require('./receipt');

const usage = [
  'npm start -- --list-groups',
  'npm start -- --group <group-id@g.us> --folder <path>'
].join('\n');

function logSaved(name) {
  console.log(name.startsWith('review-') ? `Needs review: ${name}` : `Saved: ${name}`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      'list-groups': { type: 'boolean' },
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
  const validGroup = /^\d+(?:-\d+)?@g\.us$/.test(values.group);
  if (listGroups ? values.group || values.folder : !validGroup || !values.folder?.trim()) {
    throw new Error(usage);
  }

  const folder = listGroups ? null : resolve(values.folder);
  if (folder) await mkdir(folder, { recursive: true });
  const { Client, LocalAuth } = require('whatsapp-web.js');
  const qrCode = require('qrcode-terminal');
  const client = new Client({ authStrategy: new LocalAuth() });
  client.on('qr', code => {
    console.log('On your phone, open WhatsApp > Linked devices > Link a device. Scan this code:');
    qrCode.generate(code, { small: true });
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

    if (listGroups) {
      const chats = await client.getChats();
      for (const chat of chats.filter(chat => chat.isGroup)) {
        console.log(`${chat.id._serialized}\t${chat.name}`);
      }
      return;
    }

    const group = await client.getChatById(values.group);
    if (!group?.isGroup) throw new Error('Group not found. Run with --list-groups to find its ID.');

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
      if (chatId !== values.group || message.type !== 'image' || !message.hasMedia) return;
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
    if (client.pupBrowser) await client.destroy();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
