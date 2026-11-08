async function loadPhotoIds(page, groupId) {
  return page.evaluate(async id => {
    const chats = window.require('WAWebCollections').Chat;
    const chat = chats.getModelsArray().find(item =>
      (item.id?._serialized ?? item.id?.serialized ?? item.id?.$1) === id);
    if (!chat) throw new Error('The selected group is no longer available.');

    const { loadEarlierMsgs } = window.require('WAWebChatLoadMessages');
    const seen = new Set();
    const photos = [];
    let missingIds = 0;
    let batch = chat.msgs.getModelsArray();
    let firstBatch = true;
    do {
      const previousCount = seen.size;
      for (const message of batch) {
        const messageId = message.id?._serialized ?? message.id?.$1;
        const image = message.type === 'image' ||
          (message.type === 'document' && message.mimetype?.startsWith('image/'));
        if (!messageId) {
          if (image) missingIds++;
          continue;
        }
        if (seen.has(messageId)) continue;
        seen.add(messageId);
        if (image) photos.push(messageId);
      }
      if (!firstBatch && seen.size === previousCount) break;
      firstBatch = false;
      batch = await loadEarlierMsgs({ chat });
    } while (batch?.length);
    return { photos, missingIds };
  }, groupId);
}

async function downloadPhoto(page, id) {
  return page.evaluate(async messageId => {
    const messages = window.require('WAWebCollections').Msg;
    const message = messages.get(messageId) ?? (await messages.getMessagesById([messageId]))?.messages?.[0];
    if (!message?.directPath || !message.mimetype?.startsWith('image/')) return null;

    const cached = message.mediaObject?.mediaBlob?.forceToBlob?.();
    if (cached) {
      const bytes = await cached.arrayBuffer();
      return { data: await window.WWebJS.arrayBufferToBase64Async(bytes), mimetype: message.mimetype };
    }

    // WhatsApp Web's download manager needs the MIME type for uncached images.
    const { downloadManager } = window.require('WAWebDownloadManager');
    const downloadQpl = {
      addAnnotations() { return this; },
      addPoint() { return this; }
    };
    let bytes;
    try {
      bytes = await downloadManager.downloadAndMaybeDecrypt({
        directPath: message.directPath,
        encFilehash: message.encFilehash,
        filehash: message.filehash,
        mediaKey: message.mediaKey,
        mediaKeyTimestamp: message.mediaKeyTimestamp,
        type: message.type,
        mimetype: message.mimetype,
        signal: AbortSignal.timeout(30_000),
        downloadQpl
      });
    } catch (error) {
      const status = error.status ?? error.statusCode;
      const reason = Number.isInteger(status) ? 'HTTP ' + status : error.name;
      throw new Error('WhatsApp media download failed' + (reason ? ' (' + reason + ').' : '.'));
    }
    return { data: await window.WWebJS.arrayBufferToBase64Async(bytes), mimetype: message.mimetype };
  }, id);
}

module.exports = { downloadPhoto, loadPhotoIds };
