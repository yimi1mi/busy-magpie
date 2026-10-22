'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const {spawnSync} = require('node:child_process');
const {
  MAX_COMPRESSED_BYTES, MAX_UNCOMPRESSED_BYTES, canonicalManifest, compareVersions,
  createManifest, createPackage, sha256, verifyPackage,
} = require('../shell/package.cjs');
const {createStore} = require('../shell/store.cjs');
const {buildPayload, collectFiles} = require('../tools/build-payload.cjs');

const keyPair = crypto.generateKeyPairSync('ed25519');
const publicPem = keyPair.publicKey.export({type: 'spki', format: 'pem'});
const privatePem = keyPair.privateKey.export({type: 'pkcs8', format: 'pem'});
const verification = {trustedKeys: {'test-key': publicPem}, shellVersion: '1.4.0'};

function filesFor(text = 'module.exports = "business";') {
  return new Map([
    ['src/main.js', Buffer.from(text)], ['src/preload.js', Buffer.from('// preload')],
    ['web/index.html', Buffer.from('<html>business</html>')], ['assets/icon.png', Buffer.from([0, 1, 2, 3])],
  ]);
}

function fixture({files = filesFor(), version = '1.4.1', minShellVersion = '1.4.0', shellApi = 1} = {}) {
  const manifest = createManifest({version, minShellVersion, shellApi, keyId: 'test-key', files, notes: 'fixture'});
  return {files, manifest, buffer: createPackage({manifest, files, privateKey: privatePem})};
}

function envelope(buffer) { return JSON.parse(zlib.gunzipSync(buffer)); }
function encode(document) { return zlib.gzipSync(Buffer.from(JSON.stringify(document))); }
function resign(document) {
  document.signature = crypto.sign(null, Buffer.from(canonicalManifest(document.manifest)), keyPair.privateKey).toString('base64');
  return encode(document);
}
function hasCode(code) { return error => error.code === code; }
function temporary(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'busy-magpie-payload-')));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  return directory;
}
function storeAt(directory) { return createStore({root: directory, ...verification}); }

test('canonical signatures sort recursive object keys while preserving array order', () => {
  assert.equal(canonicalManifest({z: [{b: 2, a: 1}, 3], a: '文'}), '{"a":"文","z":[{"a":1,"b":2},3]}');
  const data = fixture();
  const document = envelope(data.buffer);
  document.manifest = Object.fromEntries(Object.entries(document.manifest).reverse());
  assert.equal(verifyPackage(encode(document), verification).manifestHash, sha256(canonicalManifest(data.manifest)));
  document.manifest.files.reverse();
  assert.throws(() => verifyPackage(encode(document), verification), hasCode('INVALID_SIGNATURE'));
});

test('a real signed package returns exactly its authenticated file bytes', () => {
  const data = fixture();
  const actual = verifyPackage(data.buffer, verification);
  assert.deepEqual(actual.manifest, data.manifest);
  assert.deepEqual(actual.files, data.files);
  assert.match(actual.manifestHash, /^[a-f0-9]{64}$/);
});

test('tampered manifests, unknown keys, signatures, hashes and bytes are rejected', () => {
  const data = fixture();
  const changedManifest = envelope(data.buffer);
  changedManifest.manifest.version = '1.4.2';
  assert.throws(() => verifyPackage(encode(changedManifest), verification), hasCode('INVALID_SIGNATURE'));
  assert.throws(() => verifyPackage(data.buffer, {...verification, trustedKeys: {}}), hasCode('INVALID_SIGNATURE'));
  const changedSignature = envelope(data.buffer);
  changedSignature.signature = Buffer.alloc(64).toString('base64');
  assert.throws(() => verifyPackage(encode(changedSignature), verification), hasCode('INVALID_SIGNATURE'));
  const changedFile = envelope(data.buffer);
  changedFile.files['src/main.js'] = Buffer.alloc(data.files.get('src/main.js').length, 120).toString('base64');
  assert.throws(() => verifyPackage(encode(changedFile), verification), hasCode('HASH_MISMATCH'));
  const changedHash = envelope(data.buffer);
  changedHash.manifest.files[0].sha256 = '0'.repeat(64);
  assert.throws(() => verifyPackage(resign(changedHash), verification), hasCode('HASH_MISMATCH'));
});

test('manifest entries and encoded files form exactly the same required file set', () => {
  const data = fixture();
  for (const change of [
    document => { document.files['src/extra.js'] = ''; },
    document => { delete document.files['src/main.js']; },
    document => { delete document.files['src/main.js']; document.files['src/extra.js'] = ''; },
    document => { document.manifest.files = document.manifest.files.filter(file => file.path !== 'src/preload.js'); delete document.files['src/preload.js']; },
    document => { document.manifest.files[0].symlink = 'elsewhere'; },
    document => { document.manifest.entry = '../../elsewhere'; },
    document => { document.extra = 'unexpected'; },
  ]) {
    const document = envelope(data.buffer);
    change(document);
    assert.throws(() => verifyPackage(resign(document), verification), hasCode('INVALID_PACKAGE'));
  }
});

test('unsafe paths and shell-owned code are rejected before any extraction', () => {
  const data = fixture();
  for (const unsafe of [
    '../src/main.js', '/src/main.js', 'C:/src/main.js', 'src\\main.js', 'src/../evil.js', 'src/./evil.js',
    'src//evil.js', 'src/evil.js:stream', 'src/NUL.js', 'src/COM1.txt', 'src/evil.js.', 'src/evil.js ',
    'src/\0evil.js', 'src/evil?.js', 'src/windows-blur.cjs', 'shell/main.js', 'plugin/index.mjs', 'node_modules/pkg/index.js',
  ]) {
    const document = envelope(data.buffer);
    const entry = document.manifest.files.find(file => file.path === 'assets/icon.png');
    const oldPath = entry.path;
    entry.path = unsafe;
    document.files[unsafe] = document.files[oldPath];
    delete document.files[oldPath];
    assert.throws(() => verifyPackage(resign(document), verification), hasCode('UNSAFE_PATH'), unsafe);
  }
});

test('file casing, directory casing and file/directory prefix collisions are rejected', () => {
  for (const added of [
    [['src/MAIN.js', Buffer.from('case')]],
    [['web/Modules/a.js', Buffer.from('a')], ['web/modules/b.js', Buffer.from('b')]],
    [['src/main.js/child', Buffer.from('child')]],
  ]) {
    const data = fixture();
    const document = envelope(data.buffer);
    for (const [name, bytes] of added) {
      document.manifest.files.push({path: name, size: bytes.length, sha256: sha256(bytes)});
      document.files[name] = bytes.toString('base64');
    }
    assert.throws(() => verifyPackage(resign(document), verification), hasCode('UNSAFE_PATH'));
  }
});

test('signed compatibility requirements compare full semantic versions and exact shell API', () => {
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('1.4.0-rc.10', '1.4.0-rc.2'), 1);
  assert.equal(compareVersions('1.4.0', '1.4.0-rc.2'), 1);
  assert.equal(compareVersions('1.4.0+build', '1.4.0'), 0);
  assert.throws(() => verifyPackage(fixture({minShellVersion: '1.4.1'}).buffer, verification), hasCode('INCOMPATIBLE_SHELL'));
  assert.throws(() => verifyPackage(fixture({shellApi: 2}).buffer, verification), hasCode('INCOMPATIBLE_SHELL'));
  assert.throws(() => verifyPackage(fixture().buffer, {...verification, shellVersion: '1.4.0-rc.1'}), hasCode('INCOMPATIBLE_SHELL'));
  assert.throws(() => fixture({version: '../escape'}), hasCode('INVALID_PACKAGE'));
  assert.throws(() => fixture({version: '1.4.0-01'}), hasCode('INVALID_PACKAGE'));
});

test('compressed bytes, expanded JSON, number of files, UTF-8 and base64 have strict bounds', () => {
  assert.throws(() => verifyPackage(Buffer.alloc(MAX_COMPRESSED_BYTES + 1), verification), hasCode('INVALID_PACKAGE'));
  const bomb = zlib.gzipSync(Buffer.alloc(MAX_UNCOMPRESSED_BYTES + 1, 32), {level: 1});
  assert.throws(() => verifyPackage(bomb, verification), hasCode('INVALID_PACKAGE'));
  assert.throws(() => verifyPackage(zlib.gzipSync(Buffer.from([0xff])), verification), hasCode('INVALID_PACKAGE'));
  const manyFiles = filesFor();
  for (let i = 0; i < 509; i++) manyFiles.set('assets/file-' + i, Buffer.alloc(0));
  assert.throws(() => fixture({files: manyFiles}), hasCode('INVALID_PACKAGE'));
  const document = envelope(fixture().buffer);
  document.files['assets/icon.png'] = 'AAECAx==';
  assert.throws(() => verifyPackage(encode(document), verification), hasCode('INVALID_PACKAGE'));
});

test('large valid file data does not depend on recursive regular-expression matching', () => {
  const files = filesFor();
  files.set('assets/large.bin', Buffer.alloc(4 * 1024 * 1024, 127));
  const data = fixture({files});
  assert.equal(verifyPackage(data.buffer, verification).files.get('assets/large.bin').length, 4 * 1024 * 1024);
});

test('staging is immutable, has a minimal descriptor, and does not alter current files or state', t => {
  const root = temporary(t);
  const currentRoot = path.join(root, 'current');
  fs.mkdirSync(currentRoot);
  fs.writeFileSync(path.join(currentRoot, 'main.js'), 'running version');
  fs.writeFileSync(path.join(root, 'state.json'), '{"current":"keep"}');
  const store = storeAt(root);
  const data = fixture();
  const descriptor = store.stage(data.buffer);
  assert.deepEqual(Object.keys(descriptor).sort(), ['id', 'manifestHash', 'version']);
  const verified = store.verify(descriptor);
  assert.equal(verified.root, path.join(root, 'versions', descriptor.id));
  assert.deepEqual(verified.manifest, data.manifest);
  const initialTime = fs.statSync(path.join(verified.root, 'src/main.js')).mtimeMs;
  assert.deepEqual(store.stage(data.buffer), descriptor);
  assert.equal(fs.statSync(path.join(verified.root, 'src/main.js')).mtimeMs, initialTime);
  const changedData = fixture({files: filesFor('module.exports = "changed";')});
  const second = store.stage(changedData.buffer);
  assert.notEqual(second.id, descriptor.id);
  assert.equal(fs.readFileSync(path.join(verified.root, 'src/main.js'), 'utf8'), data.files.get('src/main.js').toString());
  assert.throws(() => store.stage(Buffer.from('broken')), hasCode('INVALID_PACKAGE'));
  assert.equal(fs.readFileSync(path.join(currentRoot, 'main.js'), 'utf8'), 'running version');
  assert.equal(fs.readFileSync(path.join(root, 'state.json'), 'utf8'), '{"current":"keep"}');
  assert.equal(fs.readdirSync(path.join(root, 'versions')).some(name => name.startsWith('.stage-')), false);
});

test('every verification rechecks file bytes, archive signatures and complete directory contents', t => {
  for (const kind of ['file', 'missing', 'extra-file', 'extra-directory', 'archive']) {
    const root = path.join(temporary(t), kind);
    const store = storeAt(root);
    const data = fixture();
    const descriptor = store.stage(data.buffer);
    const directory = store.verify(descriptor).root;
    if (kind === 'file') fs.writeFileSync(path.join(directory, 'src/main.js'), 'tampered');
    if (kind === 'missing') fs.unlinkSync(path.join(directory, 'src/main.js'));
    if (kind === 'extra-file') fs.writeFileSync(path.join(directory, 'web/extra.js'), 'extra');
    if (kind === 'extra-directory') fs.mkdirSync(path.join(directory, 'web/empty'));
    if (kind === 'archive') {
      const document = envelope(data.buffer);
      document.manifest.notes = 'unsigned modification';
      fs.writeFileSync(path.join(directory, '.package.bmpkg'), encode(document));
    }
    assert.throws(() => store.verify(descriptor), hasCode(kind === 'archive' ? 'INVALID_SIGNATURE' : 'STORE_TAMPERED'), kind);
    assert.throws(() => store.stage(data.buffer), hasCode(kind === 'archive' ? 'INVALID_SIGNATURE' : 'STORE_TAMPERED'), kind);
  }
});

test('descriptors cannot redirect store verification or substitute another signed version', t => {
  const root = temporary(t);
  const store = storeAt(root);
  const descriptor = store.stage(fixture().buffer);
  assert.throws(() => store.verify({...descriptor, root: path.join(root, 'elsewhere')}), hasCode('INVALID_DESCRIPTOR'));
  assert.throws(() => store.verify({...descriptor, id: '../../current'}), hasCode('INVALID_DESCRIPTOR'));
  assert.throws(() => store.verify({...descriptor, manifestHash: descriptor.manifestHash.slice(0, 16) + '0'.repeat(48)}), hasCode('STORE_TAMPERED'));
  const other = fixture({version: '1.4.2'});
  const actual = store.verify(descriptor);
  fs.writeFileSync(path.join(actual.root, '.package.bmpkg'), other.buffer);
  assert.throws(() => store.verify(descriptor), hasCode('STORE_TAMPERED'));
});

test('store paths and extracted directory links are refused without following their targets', t => {
  const base = temporary(t);
  const outside = path.join(base, 'outside');
  fs.mkdirSync(outside);
  const alias = path.join(base, 'alias');
  try { fs.symlinkSync(outside, alias, 'junction'); } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) { t.skip('Directory symlink creation is unavailable: ' + error.code); return; }
    throw error;
  }
  assert.throws(() => storeAt(alias).stage(fixture().buffer), hasCode('STORE_TAMPERED'));
  assert.deepEqual(fs.readdirSync(outside), []);
  const store = storeAt(path.join(base, 'store'));
  const descriptor = store.stage(fixture().buffer);
  const actual = store.verify(descriptor);
  fs.renameSync(path.join(actual.root, 'web'), path.join(outside, 'web'));
  fs.symlinkSync(path.join(outside, 'web'), path.join(actual.root, 'web'), 'junction');
  assert.throws(() => store.verify(descriptor), hasCode('STORE_TAMPERED'));
  assert.equal(fs.readFileSync(path.join(outside, 'web/index.html'), 'utf8'), '<html>business</html>');
});

test('build produces a signed business-only artifact and matching transport feed', t => {
  const base = temporary(t);
  const sourceRoot = path.join(base, 'source');
  const outputDir = path.join(base, 'release');
  for (const [name, bytes] of filesFor()) {
    const target = path.join(sourceRoot, ...name.split('/'));
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.writeFileSync(target, bytes);
  }
  for (const name of ['src/windows-blur.cjs', 'shell/main.cjs', 'node_modules/dependency/index.js', 'plugin/server.mjs']) {
    const target = path.join(sourceRoot, ...name.split('/'));
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.writeFileSync(target, 'excluded');
  }
  fs.writeFileSync(path.join(sourceRoot, 'package.json'), '{"version":"1.4.8"}');
  const keyFile = path.join(base, 'release-key.pem');
  fs.writeFileSync(keyFile, privatePem);
  const result = buildPayload({sourceRoot, outputDir, keyFile, keyId: 'test-key', notes: 'Release notes'});
  const bytes = fs.readFileSync(result.packagePath);
  const feed = JSON.parse(fs.readFileSync(result.feedPath));
  assert.equal(path.basename(result.packagePath), '1.4.8.bmpkg');
  assert.deepEqual(feed, {format: 1, version: '1.4.8', minShellVersion: '1.4.0', shellApi: 1, packageUrl: '1.4.8.bmpkg', sha256: sha256(bytes), size: bytes.length, notes: 'Release notes'});
  const actual = verifyPackage(bytes, verification);
  assert.deepEqual(actual.files, filesFor());
  assert.equal(actual.manifest.notes, 'Release notes');
  const absoluteFeed = buildPayload({sourceRoot, outputDir, keyFile, keyId: 'test-key', baseUrl: 'https://example.test/releases'}).feed;
  assert.equal(absoluteFeed.packageUrl, 'https://example.test/releases/1.4.8.bmpkg');
  assert.equal(fs.readFileSync(keyFile, 'utf8'), privatePem);
});

test('build requires a supplied key and rejects source symlinks before creating artifacts', t => {
  const base = temporary(t);
  const outputDir = path.join(base, 'release');
  assert.throws(() => buildPayload({outputDir, keyId: 'test-key'}), /explicit|require/i);
  assert.equal(fs.existsSync(outputDir), false);
  const cli = spawnSync(process.execPath, [path.resolve(__dirname, '../tools/build-payload.cjs'), '--output', outputDir], {encoding: 'utf8'});
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /--key-file PEM/);
  assert.equal(fs.existsSync(outputDir), false);
  const source = path.join(base, 'source');
  for (const name of ['src', 'web', 'assets', 'external']) fs.mkdirSync(path.join(source, name), {recursive: true});
  const unsafeKey = path.join(source, 'assets', 'private-key.pem');
  fs.writeFileSync(unsafeKey, privatePem);
  assert.throws(() => buildPayload({sourceRoot: source, outputDir, keyFile: unsafeKey, keyId: 'test-key'}), /signing key must be kept outside/);
  assert.equal(fs.existsSync(outputDir), false);
  fs.unlinkSync(unsafeKey);
  try { fs.symlinkSync(path.join(source, 'external'), path.join(source, 'assets', 'linked'), 'junction'); } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) { t.skip('Directory symlink creation is unavailable: ' + error.code); return; }
    throw error;
  }
  assert.throws(() => collectFiles(source), /symbolic links/);
});
