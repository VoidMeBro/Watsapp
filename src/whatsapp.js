async function loadPhotoIds(page, groupId, start, end) {
  return page.evaluate(async ({ id, start, end }) => {
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
      let reachedPreviousMonth = false;
      for (const message of batch) {
        if (message.t < start) reachedPreviousMonth = true;
        const messageId = message.id?._serialized ?? message.id?.$1;
        if (messageId) {
          if (seen.has(messageId)) continue;
          seen.add(messageId);
        }
        if (message.type !== 'image' || !(message.t >= start && message.t < end)) continue;
        if (messageId) photos.push(messageId);
        else missingIds++;
      }
      if (reachedPreviousMonth || (!firstBatch && seen.size === previousCount)) break;
      firstBatch = false;
      batch = await loadEarlierMsgs({ chat });
    } while (batch?.length);
    return { photos, missingIds };
  }, { id: groupId, start, end });
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
