async function downloadPhoto(page, id) {
  return page.evaluate(async messageId => {
    const messages = window.require('WAWebCollections').Msg;
    const message = messages.get(messageId) ?? (await messages.getMessagesById([messageId]))?.messages?.[0];
    if (message?.type !== 'image' || !message.directPath) return null;

    // WhatsApp Web's download manager needs the MIME type for uncached images.
    const { downloadManager } = window.require('WAWebDownloadManager');
    const downloadQpl = {
      addAnnotations() { return this; },
      addPoint() { return this; }
    };
    const bytes = await downloadManager.downloadAndMaybeDecrypt({
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
    return { data: await window.WWebJS.arrayBufferToBase64Async(bytes), mimetype: message.mimetype };
  }, id);
}

module.exports = { downloadPhoto };
