// Meeting Bot's store listing is fetched on its own. A missing app.json fails
// at once, and the check never opens another app's page.
import http from 'node:http';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { storeAppListing } from '../../src/driver.js';

function serve(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, url: 'http://127.0.0.1:' + server.address().port }));
  });
}

test('a missing Meeting Bot listing fails without asking for any other app', async () => {
  const hits = [];
  const { server, url } = await serve((req, res) => {
    hits.push(req.url);
    if (req.url === '/apps/meeting-bot/app.json') { res.writeHead(404); res.end('no'); return; }
    // Another app's store page would hang. This check must not open it.
  });
  const t0 = Date.now();
  await assert.rejects(() => storeAppListing(url, 'meeting-bot'), /has no meeting-bot app/);
  assert.ok(Date.now() - t0 < 2000);
  assert.deepEqual(hits, ['/apps/meeting-bot/app.json']);
  server.close();
});

test('a listing whose appId matches is the Meeting Bot app', async () => {
  const { server, url } = await serve((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ appId: 'meeting-bot', version: '1' }));
  });
  const listed = await storeAppListing(url, 'meeting-bot');
  assert.equal(listed.appId, 'meeting-bot');
  server.close();
});
