'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const {EventEmitter} = require('node:events');
const {createManifest, createPackage, sha256} = require('../shell/package.cjs');
const {createStore} = require('../shell/store.cjs');
const {createJournal} = require('../shell/journal.cjs');
const {createUpdater, safeUrl, readResponse} = require('../shell/updater.cjs');

const keys = crypto.generateKeyPairSync('ed25519');
const trustedKeys = {'updater-fixture': keys.publicKey.export({type: 'spki', format: 'pem'})};

function payload({version = '1.4.1', minShellVersion = '1.4.0', shellApi = 1, text = '// business fixture', large = false} = {}) {
  const files = new Map([
    ['src/main.js', Buffer.from(text)], ['src/preload.js', Buffer.from('// preload')],
    ['web/index.html', Buffer.from('<html>ready</html>')],
  ]);
  if (large) files.set('assets/noise.bin', crypto.randomBytes(128 * 1024));
  const manifest = createManifest({version, minShellVersion, shellApi, keyId: 'updater-fixture', files, notes: 'Signed release notes'});
  const bytes = createPackage({manifest, files, privateKey: keys.privateKey});
  const feed = {format: 1, version, minShellVersion, shellApi, packageUrl: version + '.bmpkg', sha256: sha256(bytes), size: bytes.length, notes: 'Release notes'};
  return {bytes, feed};
}

async function service(t, route) {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    Promise.resolve(route(request, response)).catch(error => {
      if (!response.headersSent) response.writeHead(500);
      response.end(error.message);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await closed;
  });
  return {base: 'http://127.0.0.1:' + server.address().port, requests};
}

function send(response, value, status = 200) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  response.writeHead(status, {'content-length': bytes.length});
  response.end(bytes);
}

function hostUpdater({version = '1.4.0', check} = {}) {
  const host = new EventEmitter();
  host.calls = {check: 0, download: 0, quit: 0};
  host.feedURL = 'https://example.test/host/latest.yml';
  host.setFeedURL = () => { throw new Error('The business updater must not change the host feed'); };
  host.checkForUpdates = async () => {
    host.calls.check++;
    return check ? check() : {updateInfo: {version}};
  };
  host.downloadUpdate = async () => {
    host.calls.download++;
    host.emit('download-progress', {total: 4000, transferred: 4000, percent: 100});
    host.emit('update-downloaded', {version});
    return ['installer.exe'];
  };
  host.quitAndInstall = () => { host.calls.quit++; throw new Error('Installer launch is outside these module tests'); };
  return host;
}

function harness(t, {feedUrl, host = hostUpdater(), allowLocal = true, enabled = true, fetchImpl, currentVersion = '1.4.0'} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'busy-magpie-updater-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const builtin = {root: path.join(root, 'builtin'), version: '1.4.0'};
  fs.mkdirSync(builtin.root);
  const actualStore = createStore({root, trustedKeys, shellVersion: '1.4.0'});
  const stageCalls = [];
  const store = {
    stage(bytes) { const result = actualStore.stage(bytes); stageCalls.push(result); return result; },
    verify: actualStore.verify,
  };
  const journal = createJournal({root, builtin, store});
  const events = [];
  const app = {getPath: () => path.join(root, 'user-data'), quit: () => { throw new Error('App quit is outside these module tests'); }};
  const updater = createUpdater({app, root, builtin, shellVersion: '1.4.0', currentVersion, store, journal, trustedKeys,
    feedUrl, hostUpdater: host, allowLocal, enabled, ...(fetchImpl ? {fetchImpl} : {})});
  for (const name of ['checking-for-update', 'update-available', 'update-not-available', 'download-progress', 'update-downloaded', 'error']) {
    updater.on(name, value => events.push({name, value}));
  }
  return {root, updater, store, journal, host, events, stageCalls};
}

function eventsOf(h, name) { return h.events.filter(event => event.name === name).map(event => event.value); }

test('a signed business release downloads with byte progress and stages without switching the running version', async t => {
  const release = payload({large: true});
  const remote = await service(t, async (request, response) => {
    if (request.url === '/business/business-latest.json') return send(response, release.feed);
    if (request.url === '/business/1.4.1.bmpkg') {
      response.writeHead(200, {'content-length': release.bytes.length});
      const middle = Math.floor(release.bytes.length / 2);
      response.write(release.bytes.subarray(0, middle));
      await new Promise(resolve => setTimeout(resolve, 15));
      return response.end(release.bytes.subarray(middle));
    }
    send(response, {}, 404);
  });
  const h = harness(t, {feedUrl: remote.base + '/business/business-latest.json'});
  const stateBefore = h.journal.read();
  const result = await h.updater.checkForUpdates();
  assert.equal(result.updateInfo.kind, 'business');
  assert.equal(result.updateInfo.version, '1.4.1');
  assert.equal(result.updateInfo.releaseNotes, 'Release notes');
  assert.equal(eventsOf(h, 'update-available').length, 1);
  assert.equal(h.stageCalls.length, 0);
  const downloaded = await h.updater.downloadUpdate();
  assert.equal(h.stageCalls.length, 1);
  assert.deepEqual(downloaded, [h.stageCalls[0].id]);
  assert.equal(h.store.verify(h.stageCalls[0]).version, '1.4.1');
  assert.equal(eventsOf(h, 'update-downloaded').length, 1);
  const progress = eventsOf(h, 'download-progress');
  assert.ok(progress.length >= 2);
  let previous = 0;
  for (const value of progress) {
    assert.equal(value.total, release.bytes.length);
    assert.ok(value.transferred >= previous && value.transferred <= value.total);
    previous = value.transferred;
  }
  assert.equal(progress.at(-1).transferred, release.bytes.length);
  assert.equal(progress.at(-1).percent, 100);
  assert.deepEqual(h.journal.read(), stateBefore);
  assert.deepEqual(h.host.calls, {check: 1, download: 0, quit: 0});
  assert.deepEqual(remote.requests, ['/business/business-latest.json', '/business/1.4.1.bmpkg']);
});

test('host and business releases retain separate feeds and installer downloads stay on the host updater', async t => {
  const release = payload({version: '1.5.0'});
  const remote = await service(t, (request, response) => {
    if (request.url === '/business/business-latest.json') return send(response, release.feed);
    if (request.url === '/host/latest.yml') return response.end('version: 1.4.2\n');
    send(response, {}, 404);
  });
  const host = hostUpdater({version: '1.4.2', check: async () => {
    const text = await (await fetch(remote.base + '/host/latest.yml')).text();
    assert.equal(text, 'version: 1.4.2\n');
    return {updateInfo: {version: '1.4.2'}};
  }});
  const h = harness(t, {feedUrl: remote.base + '/business/business-latest.json', host});
  const result = await h.updater.checkForUpdates();
  assert.equal(result.updateInfo.kind, 'shell');
  assert.equal(result.updateInfo.version, '1.4.2');
  assert.equal(host.feedURL, 'https://example.test/host/latest.yml');
  assert.equal(host.autoDownload, false);
  assert.equal(host.autoInstallOnAppQuit, false);
  assert.equal(host.allowPrerelease, false);
  assert.deepEqual(await h.updater.downloadUpdate(), ['installer.exe']);
  assert.deepEqual(host.calls, {check: 1, download: 1, quit: 0});
  assert.equal(h.stageCalls.length, 0);
  assert.equal(eventsOf(h, 'update-downloaded').length, 1);
  assert.deepEqual(eventsOf(h, 'download-progress'), [{total: 4000, transferred: 4000, percent: 100}]);
  assert.deepEqual(remote.requests, ['/business/business-latest.json', '/host/latest.yml']);
});

test('a missing business feed falls back to the existing host update source', async t => {
  const remote = await service(t, (_request, response) => send(response, {}, 404));
  const h = harness(t, {feedUrl: remote.base + '/business-latest.json', host: hostUpdater({version: '1.4.2'})});
  const result = await h.updater.checkForUpdates();
  assert.equal(result.updateInfo.kind, 'shell');
  assert.equal(result.updateInfo.version, '1.4.2');
  assert.equal(h.host.calls.check, 1);
  assert.equal(eventsOf(h, 'error').length, 0);
  assert.equal(h.stageCalls.length, 0);
});

test('host feed failure does not block a valid signed business release', async t => {
  const release = payload();
  const remote = await service(t, (request, response) => request.url.endsWith('.bmpkg') ? send(response, release.bytes) : send(response, release.feed));
  const host = hostUpdater({check: async () => { throw new Error('host feed offline'); }});
  const h = harness(t, {feedUrl: remote.base + '/business-latest.json', host});
  assert.equal((await h.updater.checkForUpdates()).updateInfo.kind, 'business');
  await h.updater.downloadUpdate();
  assert.equal(eventsOf(h, 'update-downloaded').length, 1);
  assert.equal(eventsOf(h, 'error').length, 0);
  assert.equal(h.stageCalls.length, 1);
});

test('preview mode disables both update sources and leaves no downloadable target', async t => {
  const h = harness(t, {feedUrl: 'https://example.test/business-latest.json', enabled: false, fetchImpl: async () => { throw new Error('Preview must not fetch updates'); }});
  const result = await h.updater.checkForUpdates();
  assert.equal(result.updateInfo.version, '1.4.0');
  assert.equal(h.host.calls.check, 0);
  assert.equal(eventsOf(h, 'update-available').length, 0);
  assert.equal(eventsOf(h, 'update-not-available').length, 1);
  await assert.rejects(h.updater.downloadUpdate(), /先检查更新/);
  assert.equal(h.stageCalls.length, 0);
});

test('equal or older business releases are never offered or downloaded', async t => {
  const release = payload();
  const remote = await service(t, (_request, response) => send(response, release.feed));
  for (const currentVersion of ['1.4.1', '1.5.0']) {
    const h = harness(t, {feedUrl: remote.base + '/business-latest.json', currentVersion});
    assert.equal((await h.updater.checkForUpdates()).updateInfo.version, currentVersion);
    assert.equal(eventsOf(h, 'update-available').length, 0);
    assert.equal(eventsOf(h, 'update-not-available').length, 1);
    await assert.rejects(h.updater.downloadUpdate(), /先检查更新/);
    assert.equal(h.stageCalls.length, 0);
  }
  assert.equal(remote.requests.some(url => url.endsWith('.bmpkg')), false);
});

test('incompatible feed requirements fall back to a shell release without downloading the business package', async t => {
  for (const change of [{minShellVersion: '1.5.0'}, {shellApi: 2}]) {
    const release = payload();
    const remote = await service(t, (_request, response) => send(response, {...release.feed, ...change}));
    const h = harness(t, {feedUrl: remote.base + '/business-latest.json', host: hostUpdater({version: '1.5.0'})});
    assert.equal((await h.updater.checkForUpdates()).updateInfo.kind, 'shell');
    assert.equal(h.stageCalls.length, 0);
    assert.deepEqual(remote.requests, ['/business-latest.json']);
  }
});

test('signed shell requirements are enforced even if the transport feed claims compatibility', async t => {
  for (const requirements of [{minShellVersion: '1.5.0'}, {shellApi: 2}]) {
    const release = payload(requirements);
    const feed = {...release.feed, minShellVersion: '1.4.0', shellApi: 1};
    const remote = await service(t, (request, response) => request.url.endsWith('.bmpkg') ? send(response, release.bytes) : send(response, feed));
    const h = harness(t, {feedUrl: remote.base + '/business-latest.json'});
    assert.equal((await h.updater.checkForUpdates()).updateInfo.kind, 'business');
    await assert.rejects(h.updater.downloadUpdate(), error => error.code === 'INCOMPATIBLE_SHELL');
    assert.equal(h.stageCalls.length, 0);
    assert.equal(eventsOf(h, 'update-downloaded').length, 0);
    assert.equal(h.journal.read().pending, null);
  }
});

test('corrupt bytes, untrusted signatures, hashes, size mismatches and missing packages never become ready', async t => {
  for (const kind of ['corrupt', 'signature', 'sha256', 'size', 'missing']) {
    const release = payload();
    let bytes = release.bytes;
    const feed = {...release.feed};
    if (kind === 'corrupt') bytes = Buffer.from('not a compressed package');
    if (kind === 'signature') {
      const document = JSON.parse(zlib.gunzipSync(bytes));
      document.signature = Buffer.alloc(64).toString('base64');
      bytes = zlib.gzipSync(Buffer.from(JSON.stringify(document)));
    }
    if (['corrupt', 'signature'].includes(kind)) { feed.size = bytes.length; feed.sha256 = sha256(bytes); }
    if (kind === 'sha256') feed.sha256 = '0'.repeat(64);
    if (kind === 'size') feed.size++;
    const remote = await service(t, (request, response) => request.url.endsWith('.bmpkg') ? send(response, bytes, kind === 'missing' ? 404 : 200) : send(response, feed));
    const h = harness(t, {feedUrl: remote.base + '/business-latest.json'});
    await h.updater.checkForUpdates();
    await assert.rejects(h.updater.downloadUpdate());
    assert.equal(h.stageCalls.length, 0, kind);
    assert.equal(eventsOf(h, 'update-downloaded').length, 0, kind);
    assert.equal(h.journal.read().pending, null, kind);
    await assert.rejects(h.updater.quitAndInstall(), /尚未通过校验/);
  }
});

test('a valid signed package with the wrong version cannot become an install candidate', async t => {
  const release = payload({version: '1.4.2'});
  const feed = {...release.feed, version: '1.4.1'};
  const remote = await service(t, (request, response) => request.url.endsWith('.bmpkg') ? send(response, release.bytes) : send(response, feed));
  const h = harness(t, {feedUrl: remote.base + '/business-latest.json'});
  await h.updater.checkForUpdates();
  await assert.rejects(h.updater.downloadUpdate(), /版本.*不一致/);
  assert.equal(eventsOf(h, 'update-downloaded').length, 0);
  assert.equal(h.journal.read().pending, null);
  assert.equal(h.journal.read().current, null);
  await assert.rejects(h.updater.quitAndInstall(), /尚未通过校验/);
});

test('failed candidate versions stay quarantined across repeated checks and changed package bytes', async t => {
  let release = payload();
  const remote = await service(t, (request, response) => request.url.endsWith('.bmpkg') ? send(response, release.bytes) : send(response, release.feed));
  const h = harness(t, {feedUrl: remote.base + '/business-latest.json'});
  const failedDescriptor = h.store.stage(release.bytes);
  const token = h.journal.prepare(failedDescriptor);
  h.journal.rollback(token, 'candidate exited before healthy');
  assert.equal(h.journal.read().failures[0].descriptor.version, '1.4.1');
  for (let i = 0; i < 2; i++) {
    release = payload({text: '// same failed version with changed bytes ' + i});
    await h.updater.checkForUpdates();
    assert.equal(eventsOf(h, 'update-available').length, 0);
    await assert.rejects(h.updater.downloadUpdate(), /先检查更新/);
  }
  assert.equal(h.stageCalls.length, 1);
  assert.equal(remote.requests.some(url => url.endsWith('.bmpkg')), false);
  assert.ok(eventsOf(h, 'error').some(error => /不重复尝试该版本/.test(error.message)));
  release = payload({version: '1.4.2'});
  assert.equal((await h.updater.checkForUpdates()).updateInfo.version, '1.4.2');
  await h.updater.downloadUpdate();
  assert.equal(h.stageCalls.length, 2);
  assert.equal(eventsOf(h, 'update-downloaded').length, 1);
});

test('health and invalid-version failures quarantine that version while prelaunch handoff failure permits retry', async t => {
  const release = payload();
  const remote = await service(t, (request, response) => request.url.endsWith('.bmpkg') ? send(response, release.bytes) : send(response, release.feed));
  for (const reason of ['health-timeout', 'current-invalid: corrupted bytes', 'previous-invalid: corrupted bytes', 'handoff failed: worker could not start']) {
    const h = harness(t, {feedUrl: remote.base + '/business-latest.json'});
    const token = h.journal.prepare(h.store.stage(release.bytes));
    h.journal.rollback(token, reason);
    await h.updater.checkForUpdates();
    assert.equal(eventsOf(h, 'update-available').length, reason.startsWith('handoff') ? 1 : 0, reason);
  }
});

test('repeat checks and downloads share the ongoing operation and a staged release remains stable', async t => {
  const release = payload();
  const remote = await service(t, async (request, response) => {
    await new Promise(resolve => setTimeout(resolve, 10));
    return request.url.endsWith('.bmpkg') ? send(response, release.bytes) : send(response, release.feed);
  });
  const h = harness(t, {feedUrl: remote.base + '/business-latest.json'});
  const checks = [h.updater.checkForUpdates(), h.updater.checkForUpdates()];
  await Promise.all(checks);
  assert.equal(h.host.calls.check, 1);
  await Promise.all([h.updater.downloadUpdate(), h.updater.downloadUpdate()]);
  await h.updater.checkForUpdates();
  assert.equal(h.stageCalls.length, 1);
  assert.equal(h.host.calls.check, 1);
  assert.deepEqual(remote.requests, ['/business-latest.json', '/1.4.1.bmpkg']);
});

test('HTTPS is required except for explicitly enabled loopback development addresses', async () => {
  assert.equal(safeUrl('1.4.1.bmpkg', 'https://example.test/business/feed.json'), 'https://example.test/business/1.4.1.bmpkg');
  for (const value of ['http://example.test/file', 'http://127.0.0.1/file', 'file:///tmp/file', 'ftp://example.test/file', 'https://user:secret@example.test/file']) {
    assert.throws(() => safeUrl(value), /HTTPS/, value);
  }
  for (const address of ['127.0.0.1', 'localhost', '[::1]']) assert.match(safeUrl('http://' + address + '/file', undefined, true), /^http:/);
  assert.throws(() => safeUrl('http://example.test/file', undefined, true), /HTTPS/);
  let fetched = false;
  await assert.rejects(readResponse('http://example.test/file', {limit: 128, fetchImpl: async () => { fetched = true; }}), /HTTPS/);
  assert.equal(fetched, false);
});

test('response limits reject both announced oversize and chunked bodies without trusting content-length', async t => {
  const remote = await service(t, (request, response) => {
    if (request.url === '/announced') {
      response.writeHead(200, {'content-length': 1024});
      return response.end(Buffer.alloc(1024));
    }
    response.writeHead(200);
    response.write(Buffer.alloc(32));
    response.end(Buffer.alloc(33));
  });
  for (const suffix of ['/announced', '/chunked']) {
    await assert.rejects(readResponse(remote.base + suffix, {limit: 64, allowLocal: true}), /大小限制/);
  }
});

test('redirect destinations must be validated before any insecure network request is sent', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push(url);
    if (options.redirect !== 'manual') {
      requests.push('http://example.test/insecure.bmpkg');
      return new Response('insecure response', {status: 200});
    }
    return {status: 302, ok: false, url, headers: new Headers({location: 'http://example.test/insecure.bmpkg'})};
  };
  await assert.rejects(readResponse('https://example.test/business.bmpkg', {limit: 128, fetchImpl}), /HTTPS/);
  assert.deepEqual(requests, ['https://example.test/business.bmpkg']);
});

test('safe relative redirects deliver bytes while redirect loops stop within the hop limit', async t => {
  const remote = await service(t, (request, response) => {
    if (request.url === '/start') { response.writeHead(302, {location: './nested/next'}); return response.end(); }
    if (request.url === '/nested/next') { response.writeHead(307, {location: '../payload'}); return response.end(); }
    if (request.url === '/payload') return send(response, Buffer.from('signed bytes'));
    response.writeHead(308, {location: '/loop'});
    response.end();
  });
  assert.equal((await readResponse(remote.base + '/start', {limit: 128, allowLocal: true})).toString(), 'signed bytes');
  assert.deepEqual(remote.requests, ['/start', '/nested/next', '/payload']);
  await assert.rejects(readResponse(remote.base + '/loop', {limit: 128, allowLocal: true}), /重定向次数过多/);
  assert.ok(remote.requests.filter(url => url === '/loop').length <= 6);
});
