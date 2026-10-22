'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const yaml = require('js-yaml');
const {prepare, collect} = require('../tools/release-artifacts.cjs');

const version = require('../package.json').version;
const sourceSha = '1234567890abcdef1234567890abcdef12345678';
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const sha512 = bytes => crypto.createHash('sha512').update(bytes).digest('base64');

function temporary(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'busy-release-artifacts-')));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  return directory;
}

function fixture(directory, platform, {maps = false} = {}) {
  fs.mkdirSync(directory, {recursive: true});
  const prefix = 'Busy.Magpie-' + version;
  const names = platform === 'windows' ? [prefix + '-win-x64.exe']
    : ['x64', 'arm64'].flatMap(arch => ['dmg', 'zip'].map(extension => prefix + '-mac-' + arch + '.' + extension));
  const files = names.map((name, index) => {
    const bytes = Buffer.from('real binary fixture\0' + name + '\0' + index);
    fs.writeFileSync(path.join(directory, name), bytes);
    if (platform === 'windows' || maps) fs.writeFileSync(path.join(directory, name + '.blockmap'), Buffer.from('map\0' + name));
    return {url: name, size: bytes.length, sha512: sha512(bytes)};
  });
  const primary = platform === 'windows' ? files[0] : files.find(file => file.url.endsWith('-x64.zip'));
  const feed = {version, files, path: primary.url, sha512: primary.sha512, releaseDate: '2026-10-23T00:00:00.000Z'};
  const feedName = platform === 'windows' ? 'latest.yml' : 'latest-mac.yml';
  const writeFeed = () => fs.writeFileSync(path.join(directory, feedName), yaml.dump(feed));
  writeFeed();
  fs.writeFileSync(path.join(directory, 'builder-debug.yml'), 'private build diagnostics');
  fs.writeFileSync(path.join(directory, 'builder-effective-config.yaml'), 'local config');
  fs.writeFileSync(path.join(directory, 'private-test-key.pem'), 'not a real key; never publish');
  return {directory, platform, names, feed, feedName, writeFeed};
}

function preparedPair(t, {maps = true} = {}) {
  const root = temporary(t);
  const download = path.join(root, 'download');
  const windows = fixture(path.join(download, 'windows-artifact'), 'windows');
  const macos = fixture(path.join(download, 'macos-artifact'), 'macos', {maps});
  const win = prepare({...windows, version, sourceSha});
  const mac = prepare({...macos, version, sourceSha});
  return {root, download, windows, macos, win, mac, output: path.join(root, 'release')};
}

test('Windows preparation validates metadata and generates a checksum with a strict public asset manifest', t => {
  const input = fixture(temporary(t), 'windows');
  const result = prepare({...input, version, sourceSha});
  const exe = input.names[0];
  const expectedHash = sha256(fs.readFileSync(path.join(input.directory, exe)));
  assert.equal(fs.readFileSync(path.join(input.directory, exe + '.sha256'), 'utf8'), expectedHash + '  ' + exe + '\n');
  assert.deepEqual(result.manifest.assets.map(asset => asset.name).sort(), [exe, exe + '.blockmap', exe + '.sha256', 'latest.yml'].sort());
  assert.equal(result.manifest.schema, 1);
  assert.equal(result.manifest.version, version);
  assert.equal(result.manifest.sourceSha, sourceSha);
  assert.equal(result.manifest.platform, 'windows');
  assert.deepEqual(JSON.parse(fs.readFileSync(result.manifestPath)), result.manifest);
  for (const asset of result.manifest.assets) {
    const bytes = fs.readFileSync(path.join(input.directory, asset.name));
    assert.deepEqual(asset, {name: asset.name, size: bytes.length, sha256: sha256(bytes)});
  }
});

test('macOS preparation includes both architectures and all generated matching block maps', t => {
  const input = fixture(temporary(t), 'macos', {maps: true});
  const result = prepare({...input, version, sourceSha});
  assert.deepEqual(result.manifest.assets.map(asset => asset.name).sort(), [...input.names, ...input.names.map(name => name + '.blockmap'), 'latest-mac.yml'].sort());
  assert.equal(result.manifest.assets.length, 9);
  const minimal = fixture(path.join(temporary(t), 'no-maps'), 'macos');
  assert.equal(prepare({...minimal, version, sourceSha}).manifest.assets.length, 5);
  fs.writeFileSync(path.join(minimal.directory, 'orphan.zip.blockmap'), 'orphan');
  assert.throws(() => prepare({...minimal, version, sourceSha}), /Block map/);
});

test('collection copies only manifest-approved bytes and includes public SHA256SUMS but excludes internal manifests', t => {
  const p = preparedPair(t);
  const result = collect({directories: [p.download], outputDirectory: p.output, version, sourceSha});
  const expectedAssets = [...p.win.manifest.assets, ...p.mac.manifest.assets];
  assert.equal(result.manifest.assets.length, expectedAssets.length + 1);
  assert.equal(result.manifest.assets.some(asset => asset.name === 'SHA256SUMS'), true);
  assert.equal(result.manifest.assets.some(asset => asset.name.includes('release-manifest')), false);
  assert.deepEqual(fs.readdirSync(p.output).sort(), [...expectedAssets.map(asset => asset.name), 'SHA256SUMS', 'release-manifest.json'].sort());
  const sums = fs.readFileSync(path.join(p.output, 'SHA256SUMS'), 'utf8');
  for (const asset of expectedAssets) assert.ok(sums.includes(asset.sha256 + '  ' + asset.name + '\n'));
  for (const asset of result.manifest.assets) {
    const bytes = fs.readFileSync(path.join(p.output, asset.name));
    assert.equal(bytes.length, asset.size);
    assert.equal(sha256(bytes), asset.sha256);
  }
  assert.equal(fs.existsSync(path.join(p.output, 'builder-debug.yml')), false);
  assert.equal(fs.existsSync(path.join(p.output, 'private-test-key.pem')), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(result.manifestPath)), result.manifest);
});

test('required platform files and exact version filenames cannot be omitted or substituted', t => {
  for (const platform of ['windows', 'macos']) {
    const input = fixture(temporary(t), platform);
    const required = platform === 'windows' ? input.names[0] + '.blockmap' : input.names.at(-1);
    fs.unlinkSync(path.join(input.directory, required));
    assert.throws(() => prepare({...input, version, sourceSha}), error => error.code === 'ENOENT');
    assert.equal(fs.existsSync(path.join(input.directory, 'release-manifest-' + platform + '.json')), false);
  }
  const input = fixture(temporary(t), 'windows');
  assert.throws(() => prepare({...input, version: '99.0.0', sourceSha}), /matching platform asset|ENOENT/);
  assert.throws(() => prepare({...input, version, sourceSha, platform: 'linux'}), /windows or macos/);
});

test('every update feed entry and primary path must match real file bytes, sizes and version', t => {
  const changes = [
    feed => { feed.version = '99.0.0'; },
    feed => { feed.files[0].size++; },
    feed => { feed.files[0].sha512 = Buffer.alloc(64).toString('base64'); },
    feed => { feed.sha512 = Buffer.alloc(64).toString('base64'); },
    feed => { feed.size = 1; },
    feed => { feed.path = '../outside.exe'; },
    feed => { feed.files[0].url = 'https://example.test/elsewhere.exe'; },
    feed => { feed.files.push({...feed.files[0]}); },
  ];
  for (const change of changes) {
    const input = fixture(temporary(t), 'windows');
    change(input.feed);
    input.writeFeed();
    assert.throws(() => prepare({...input, version, sourceSha}));
    assert.equal(fs.existsSync(path.join(input.directory, 'release-manifest-windows.json')), false);
  }
  const mac = fixture(temporary(t), 'macos');
  mac.feed.files.at(-1).sha512 = Buffer.alloc(64).toString('base64');
  mac.writeFeed();
  assert.throws(() => prepare({...mac, version, sourceSha}), /SHA-512/);
});

test('collection rejects changed assets, wrong source commits and altered manifest sizes', t => {
  for (const kind of ['bytes', 'missing-file', 'source', 'version', 'size', 'digest']) {
    const p = preparedPair(t, {maps: false});
    if (kind === 'bytes') fs.appendFileSync(path.join(p.windows.directory, p.windows.names[0]), 'changed');
    if (kind === 'missing-file') fs.unlinkSync(path.join(p.windows.directory, p.windows.names[0]));
    if (kind === 'source') p.win.manifest.sourceSha = 'a'.repeat(40);
    if (kind === 'version') p.win.manifest.version = '99.0.0';
    if (kind === 'size') p.win.manifest.assets[0].size++;
    if (kind === 'digest') p.win.manifest.assets[0].sha256 = '0'.repeat(64);
    fs.writeFileSync(p.win.manifestPath, JSON.stringify(p.win.manifest));
    assert.throws(() => collect({directories: [p.download], outputDirectory: p.output, version, sourceSha}), undefined, kind);
    assert.equal(fs.existsSync(p.output), false, kind);
  }
});

test('collection refuses traversal, duplicates and debug files even when their manifest hash is accurate', t => {
  for (const name of ['../outside.exe', 'C:\\outside.exe', '/outside.exe', 'builder-debug.yml']) {
    const p = preparedPair(t, {maps: false});
    const bytes = Buffer.from('private build diagnostics');
    p.win.manifest.assets[0] = {name, size: bytes.length, sha256: sha256(bytes)};
    fs.writeFileSync(p.win.manifestPath, JSON.stringify(p.win.manifest));
    assert.throws(() => collect({directories: [p.download], outputDirectory: p.output, version, sourceSha}), /basename|unexpected|duplicate/);
    assert.equal(fs.existsSync(p.output), false);
  }
  const p = preparedPair(t, {maps: false});
  p.win.manifest.assets[1] = {...p.win.manifest.assets[0]};
  fs.writeFileSync(p.win.manifestPath, JSON.stringify(p.win.manifest));
  assert.throws(() => collect({directories: [p.download], outputDirectory: p.output, version, sourceSha}), /duplicate/);
});

test('both distinct platform manifests are required and duplicate directories cannot silently merge', t => {
  const p = preparedPair(t, {maps: false});
  assert.throws(() => collect({directories: [p.windows.directory], outputDirectory: p.output, version, sourceSha}), /Exactly one/);
  assert.throws(() => collect({directories: [p.windows.directory, p.windows.directory], outputDirectory: p.output, version, sourceSha}), /Duplicate platform/);
  fs.writeFileSync(path.join(p.download, 'release-manifest-extra.json'), '{}');
  assert.throws(() => collect({directories: [p.download], outputDirectory: p.output, version, sourceSha}), /Unexpected platform/);
});

test('linked directories are rejected while real macOS temporary directory paths work', t => {
  const root = temporary(t);
  const real = fixture(path.join(root, 'real'), 'windows');
  const alias = path.join(root, 'alias');
  try { fs.symlinkSync(real.directory, alias, 'junction'); } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) { t.skip('Directory links unavailable: ' + error.code); return; }
    throw error;
  }
  assert.throws(() => prepare({directory: alias, platform: 'windows', version, sourceSha}), /symbolic links/);
  const p = preparedPair(t);
  fs.symlinkSync(real.directory, path.join(p.download, 'linked'), 'junction');
  assert.throws(() => collect({directories: [p.download], outputDirectory: p.output, version, sourceSha}), /symbolic links/);
  assert.equal(fs.existsSync(p.output), false);
});

test('collection preserves a nonempty destination and rejects overlapping input and output paths', t => {
  const p = preparedPair(t, {maps: false});
  fs.mkdirSync(p.output);
  fs.writeFileSync(path.join(p.output, 'keep.txt'), 'keep');
  assert.throws(() => collect({directories: [p.download], outputDirectory: p.output, version, sourceSha}), /must be empty/);
  assert.equal(fs.readFileSync(path.join(p.output, 'keep.txt'), 'utf8'), 'keep');
  assert.throws(() => collect({directories: [p.download], outputDirectory: path.join(p.download, 'release'), version, sourceSha}), /overlap/);
});

test('CLI uses package version and GITHUB_SHA defaults and collects artifact download subdirectories', t => {
  const p = preparedPair(t, {maps: false});
  const script = path.resolve(__dirname, '../tools/release-artifacts.cjs');
  const options = {encoding: 'utf8', windowsHide: true, env: {...process.env, GITHUB_SHA: sourceSha}};
  const prepared = spawnSync(process.execPath, [script, 'prepare', '--directory', p.windows.directory, '--platform', 'windows'], options);
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.equal(JSON.parse(prepared.stdout).publicAssets.length, 4);
  const collected = spawnSync(process.execPath, [script, 'collect', '--directory', p.download, '--output', p.output], options);
  assert.equal(collected.status, 0, collected.stderr);
  assert.equal(JSON.parse(collected.stdout).publicAssets.includes('SHA256SUMS'), true);
  assert.equal(JSON.parse(collected.stdout).publicAssets.includes('release-manifest.json'), false);
});
