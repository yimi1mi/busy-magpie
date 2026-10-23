const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { fileURLToPath, pathToFileURL } = require('node:url');
const launchPolicy = require('../src/launch-policy.cjs');

function harness({ installed = '', env = {}, spawnError = false } = {}) {
  const file = path.resolve(__dirname, '../plugin/launch.hooks.mjs');
  let now = 100000, installs = 0, finish, fail;
  const starts = [], messages = [];
  const context = vm.createContext({
    process: { platform: 'darwin', env }, path, fileURLToPath, launchPolicy, Buffer,
    RELEASE: 'https://github.com/yimi1mi/busy-magpie/releases/latest',
    homedir: () => '/test/home',
    Date: class extends Date { static now() { return now; } },
    existsSync: file => file === installed,
    statSync: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    readFileSync: () => JSON.stringify({ version: '1.4.1' }),
    console: { log: message => messages.push(message), warn: message => messages.push(message) },
    installApp() { installs++; return new Promise((resolve, reject) => { finish = resolve; fail = reject; }); },
    spawn(file, args, options) {
      const child = new EventEmitter();
      child.unref = () => {};
      if (file !== 'osascript') starts.push({ file, options });
      queueMicrotask(() => spawnError ? child.emit('error', new Error('permission denied')) : child.emit('spawn'));
      return child;
    },
  });
  const source = fs.readFileSync(file, 'utf8').replace(/^import .*;$/gm, '')
    .replaceAll('import.meta.url', JSON.stringify(pathToFileURL(file).href))
    .replace('export function onRequest', 'function onRequest');
  vm.runInContext(`${source}\nglobalThis.request = onRequest;`, context, { filename: file });
  return { starts, messages, request: body => context.request(body),
    get installs() { return installs; }, finish: value => finish(value), fail: error => fail(error),
    tick: ms => { now += ms; }, settle: () => new Promise(resolve => setImmediate(resolve)),
  };
}

test('a fresh Mac downloads in the background once and starts the installed release', async () => {
  const h = harness({ env: { ELECTRON_RUN_AS_NODE: '1' } });
  const body = { model: 'example', messages: [] };
  assert.equal(h.installs, 1);
  assert.equal(h.request(body), body);
  h.tick(61000);
  assert.equal(h.request(body), body);
  assert.equal(h.installs, 1);
  assert.equal(h.starts.length, 0);
  const executable = '/test/home/Applications/Busy Magpie.app/Contents/MacOS/Busy Magpie';
  h.finish(executable);
  await h.settle();
  assert.equal(h.starts[0].file, executable);
  assert.equal(h.starts[0].options.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(h.starts[0].options.env.BUSY_MAGPIE_PLUGIN_VERSION, '1.4.1');
  h.request(body);
  assert.equal(h.starts.length, 1);
});

test('an installed Mac app starts without downloading', async () => {
  const executable = '/Applications/Busy Magpie.app/Contents/MacOS/Busy Magpie';
  const h = harness({ installed: executable });
  await h.settle();
  assert.equal(h.installs, 0);
  assert.equal(h.starts[0].file, executable);
});

test('installation failures pass requests through and never log a successful install', async () => {
  const h = harness();
  h.fail(new Error('checksum mismatch'));
  await h.settle();
  assert.equal(h.starts.length, 0);
  assert.ok(h.messages.some(message => message.includes('install failed: checksum mismatch')));
  assert.ok(!h.messages.some(message => message.includes('installed, but')));
  const body = {};
  assert.equal(h.request(body), body);
});

test('a failed spawn is not marked launched and can retry after the throttle', async () => {
  const h = harness({ installed: '/Applications/Busy Magpie.app/Contents/MacOS/Busy Magpie', spawnError: true });
  await h.settle();
  assert.ok(!h.messages.some(message => message.includes('] started ')));
  h.tick(61000);
  h.request({});
  await h.settle();
  assert.equal(h.starts.length, 2);
});

test('NO_INSTALL and NO_LAUNCH remain respected', () => {
  assert.equal(harness({ env: { BUSY_MAGPIE_NO_INSTALL: '1' } }).installs, 0);
  const h = harness({ env: { BUSY_MAGPIE_NO_LAUNCH: '1' } });
  assert.equal(h.installs, 0);
  assert.equal(h.starts.length, 0);
});
