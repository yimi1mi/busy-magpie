import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { installApp, selectAsset } from '../plugin/install.mjs';

const payload = Buffer.from('release archive');
const hash = createHash('sha256').update(payload).digest('hex');
const asset = name => ({ name, browser_download_url: `https://example.test/${name}`, digest: `sha256:${hash}` });
const arm = asset('Busy.Magpie-1.4.0-mac-arm64.zip');
const intel = asset('Busy.Magpie-1.4.0-mac-x64.zip');
const windows = asset('Busy.Magpie-1.4.0-win-x64.exe');
const relativeExe = path.join('Busy Magpie.app', 'Contents', 'MacOS', 'Busy Magpie');

async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'busy-installer-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const temporary = path.join(root, 'temporary');
  await fs.mkdir(temporary);
  const calls = [], messages = [], requests = [];
  const release = { tag_name: 'v1.4.0', assets: [arm, intel, windows] };
  const options = {
    platform: 'darwin', arch: 'arm64', home: path.join(root, 'home'), temporary,
    async fetchImpl(url) {
      requests.push(url);
      if (url.endsWith('/releases/latest')) return { ok: true, json: async () => release };
      return { ok: true, arrayBuffer: async () => payload };
    },
    async run(file, args) {
      calls.push({ file, args });
      const executable = path.join(args[3], relativeExe);
      await fs.mkdir(path.dirname(executable), { recursive: true });
      await fs.writeFile(executable, 'app', { mode: 0o755 });
    },
    log: message => messages.push(message), notify: () => {},
    ...overrides,
  };
  return { options, release, calls, messages, requests,
    applications: path.join(options.home, 'Applications'),
    async assertClean() {
      assert.deepEqual(await fs.readdir(temporary), []);
      const entries = await fs.readdir(path.join(options.home, 'Applications')).catch(() => []);
      assert.ok(entries.every(name => !name.startsWith('.busy-magpie-install-')));
    },
  };
}

test('Mac selects the matching ZIP; DMG, checksum and blockmap are not installers', () => {
  const release = { assets: [asset('Busy.Magpie-1.4.0-mac-arm64.dmg'), asset(`${arm.name}.blockmap`),
    asset(`${arm.name}.sha256`), intel, arm, windows] };
  assert.equal(selectAsset(release, 'darwin', 'arm64'), arm);
  assert.equal(selectAsset(release, 'darwin', 'x64'), intel);
  assert.equal(selectAsset(release, 'win32', 'x64'), windows);
  assert.throws(() => selectAsset({ assets: [intel] }, 'darwin', 'arm64'), /no mac-arm64.zip/);
  assert.throws(() => selectAsset(release, 'linux', 'x64'), /not supported/);
});

test('Mac downloads a release, verifies it, installs in the user Applications folder and cleans up', async t => {
  const f = await fixture(t);
  const executable = await installApp(f.options);
  assert.equal(executable, path.join(f.applications, relativeExe));
  assert.equal(await fs.readFile(executable, 'utf8'), 'app');
  assert.ok(f.requests.includes(arm.browser_download_url));
  assert.ok(!f.requests.includes(intel.browser_download_url));
  assert.equal(f.calls[0].file, '/usr/bin/ditto');
  assert.deepEqual(f.calls[0].args.slice(0, 2), ['-x', '-k']);
  assert.ok(f.messages.some(message => message.startsWith('installed ')));
  await f.assertClean();
});

test('a checksum mismatch never extracts or installs the downloaded file', async t => {
  const f = await fixture(t);
  f.release.assets = [{ ...arm, digest: `sha256:${'0'.repeat(64)}` }];
  await assert.rejects(installApp(f.options), /checksum does not match/);
  assert.equal(f.calls.length, 0);
  await f.assertClean();
});

test('a release without any checksum fails before downloading executable content', async t => {
  const f = await fixture(t);
  f.release.assets = [{ ...arm, digest: null }];
  await assert.rejects(installApp(f.options), /no SHA-256 checksum/);
  assert.equal(f.requests.length, 1);
  await f.assertClean();
});

test('older releases use the matching filename in SHA256SUMS', async t => {
  const f = await fixture(t);
  const sums = asset('SHA256SUMS');
  f.release.assets = [{ ...arm, digest: null }, sums];
  const fetch = f.options.fetchImpl;
  f.options.fetchImpl = async (url, options) => url === sums.browser_download_url
    ? { ok: true, text: async () => `${'0'.repeat(64)}  ${intel.name}\n${hash}  ${arm.name}\n` }
    : fetch(url, options);
  await installApp(f.options);
  await f.assertClean();
});

test('download errors clean up and never claim installation succeeded', async t => {
  const f = await fixture(t);
  const fetch = f.options.fetchImpl;
  f.options.fetchImpl = async (url, options) => url === arm.browser_download_url
    ? { ok: false, status: 503 } : fetch(url, options);
  await assert.rejects(installApp(f.options), /503/);
  assert.equal(f.calls.length, 0);
  assert.ok(!f.messages.some(message => message.startsWith('installed ')));
  await f.assertClean();
});

test('extraction errors remove both archive and partial bundle', async t => {
  const f = await fixture(t, { run: async () => { throw new Error('bad ZIP'); } });
  await assert.rejects(installApp(f.options), /bad ZIP/);
  assert.deepEqual(await fs.readdir(f.applications), []);
  await f.assertClean();
});

test('an archive without the application cannot be installed', async t => {
  const f = await fixture(t, { run: async () => {} });
  await assert.rejects(installApp(f.options), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(f.applications), []);
  await f.assertClean();
});

test('an existing destination is preserved', async t => {
  const f = await fixture(t);
  const destination = path.join(f.applications, 'Busy Magpie.app');
  await fs.mkdir(destination, { recursive: true });
  await fs.writeFile(path.join(destination, 'keep'), 'existing app');
  await assert.rejects(installApp(f.options), /destination already exists/);
  assert.equal(await fs.readFile(path.join(destination, 'keep'), 'utf8'), 'existing app');
  await f.assertClean();
});

test('a concurrent installation is reused without overwriting it', async t => {
  const f = await fixture(t, { findApp: () => '/Applications/Busy Magpie.app/Contents/MacOS/Busy Magpie' });
  assert.equal(await installApp(f.options), f.options.findApp());
  assert.deepEqual(await fs.readdir(f.applications), []);
  await f.assertClean();
});

test('Windows keeps silent installation and cleans up its unique temporary directory', async t => {
  const calls = [];
  const f = await fixture(t, { platform: 'win32', arch: 'x64',
    run: async (file, args) => { calls.push({ file, args }); },
    findApp: () => 'C:\\Apps\\Busy Magpie.exe',
  });
  assert.equal(await installApp(f.options), 'C:\\Apps\\Busy Magpie.exe');
  assert.ok(f.requests.includes(windows.browser_download_url));
  assert.deepEqual(calls[0].args, ['/S']);
  assert.equal(path.basename(calls[0].file), 'busy-magpie-setup.exe');
  await f.assertClean();
});

test('Windows does not report success when the installer leaves no executable', async t => {
  const f = await fixture(t, { platform: 'win32', run: async () => {} });
  await assert.rejects(installApp(f.options), /Busy Magpie.exe was not found/);
  await f.assertClean();
});
