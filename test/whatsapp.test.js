const assert = require('node:assert/strict');
const test = require('node:test');
const { loadPhotoIds } = require('../src/whatsapp');

test('loads images in the gallery month and stops at older history', async () => {
  const message = (id, t, type = 'image') => ({ id: { $1: id }, t, type });
  const batches = [
    [message('next-month', 200), message('latest', 150)],
    [message('text', 120, 'chat')],
    [message('first-day', 100), message('previous-month', 99)]
  ];
  const chat = { id: { _serialized: 'group@g.us' }, msgs: { getModelsArray: () => batches.shift() } };
  const page = {
    async evaluate(fn, args) {
      globalThis.window = {
        require(name) {
          if (name === 'WAWebCollections') return { Chat: { getModelsArray: () => [chat] } };
          return { loadEarlierMsgs: async () => {
            assert.ok(batches.length, 'looked past the previous month');
            return batches.shift();
          } };
        }
      };
      try {
        return await fn(args);
      } finally {
        delete globalThis.window;
      }
    }
  };
  assert.deepEqual(await loadPhotoIds(page, 'group@g.us', 100, 200), {
    photos: ['latest', 'first-day'],
    missingIds: 0
  });
});
