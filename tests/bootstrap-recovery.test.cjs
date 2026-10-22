'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const {EventEmitter} = require('node:events');
const {createRequire, wrap} = require('node:module');
const {createManifest, createPackage} = require('../shell/package.cjs');
const {createStore} = require('../shell/store.cjs');
const {createJournal, writeJson, alive} = require('../shell/journal.cjs');
const {validateRecovery} = require('../shell/recovery.cjs');

const bootstrapPath = path.resolve(__dirname, '../shell/bootstrap.cjs');
const bootstrapRequire = createRequire(bootstrapPath);
const bootstrapSource = fs.readFileSync(bootstrapPath, 'utf8');
const repository = path.dirname(path.dirname(bootstrapPath));
const deadPid = 2147483647;
const keys = crypto.generateKeyPairSync('ed25519');
const trustedKeys = {'bootstrap-fixture': keys.publicKey.export({type: 'spki', format: 'pem'})};
const originalSettings = '{"schema":1,"userChoice":"preserved"}';
const candidateSettings = '{"schema":99,"candidateOnly":true}';

function signedPayload(version) {
  const files = new Map([
    ['src/main.js', Buffer.from('module.exports = ' + JSON.stringify({version}) + ';')],
    ['src/preload.js', Buffer.from('// signed preload')],
    ['web/index.html', Buffer.from('<html>signed business</html>')],
  ]);
  const manifest = createManifest({version, minShellVersion: '1.4.0', shellApi: 1, keyId: 'bootstrap-fixture', files});
  return createPackage({manifest, files, privateKey: keys.privateKey});
}

function context(t, {acceptPrevious = true} = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'busy-bootstrap-recovery-')));
  t.after(() => fs.rmSync(base, {recursive: true, force: true}));
  const userData = path.join(base, 'profile');
  const root = path.join(userData, 'business-updates');
  const settings = path.join(userData, 'settings.json');
  fs.mkdirSync(root, {recursive: true});
  fs.writeFileSync(settings, originalSettings);
  const builtin = {root: repository, version: '1.4.0'};
  const store = createStore({root, trustedKeys, shellVersion: '1.4.0'});
  const journal = createJournal({root, builtin, store});
  const previous = store.stage(signedPayload('1.4.1'));
  const candidate = store.stage(signedPayload('1.4.2'));
  if (acceptPrevious) {
    const previousToken = journal.prepare(previous);
    journal.select(previousToken);
    journal.ready(previousToken, process.pid);
    journal.confirm(previousToken);
  }

  function prepare({booting = true, existed = true} = {}) {
    const token = journal.prepare(candidate);
    if (booting) {
      assert.equal(alive(deadPid), false, 'Fixture dead process ID must not be running');
      journal.select(token);
      const state = journal.read();
      state.pending.bootPid = deadPid;
      writeJson(path.join(root, 'journal.json'), state);
    }
    const directory = path.join(root, 'transactions', token);
    fs.mkdirSync(directory, {recursive: true});
    const backup = path.join(directory, 'settings.json');
    if (existed) fs.writeFileSync(backup, originalSettings);
    const config = {
      root, builtin, token, shellVersion: '1.4.0', shellApi: 1, trustedKeys, oldPid: 0,
      executable: process.execPath, args: [],
      settingsBackup: {path: backup, target: settings, existed},
    };
    const configPath = path.join(directory, 'handoff.json');
    writeJson(configPath, config);
    return {token, directory, backup, config, configPath};
  }

  function worker(token, {markerPid = process.pid, markerReady = true} = {}) {
    writeJson(path.join(root, 'supervisor.lock', 'owner.json'), {pid: process.pid, nonce: 'live-fixture', at: Date.now()});
    writeJson(path.join(root, 'handoff-' + token + '.json'), {token, pid: markerPid, ready: markerReady, at: Date.now()});
  }

  function run({args = [], singleInstance = true, windows = [], onBusinessLoad, onRelease} = {}) {
    const loads = [];
    const exits = [];
    const lifecycle = [];
    const ipcMain = new EventEmitter();
    const hostUpdater = new EventEmitter();
    hostUpdater.checkForUpdates = async () => { throw new Error('Bootstrap recovery must not fetch updates'); };
    const app = Object.assign(new EventEmitter(), {
      isPackaged: true,
      setName(name) { lifecycle.push(['name', name]); },
      setPath(name, value) { assert.equal(name, 'userData'); assert.equal(value, userData); },
      getPath(name) { return name === 'appData' ? base : userData; },
      getVersion() { return '1.4.0'; },
      getAppPath() { return repository; },
      requestSingleInstanceLock() { return singleInstance; },
      releaseSingleInstanceLock() { onRelease?.(); lifecycle.push(['release-lock']); },
      quit() { lifecycle.push(['quit']); },
      exit(code) { exits.push(code); },
    });
    const simulatedProcess = Object.assign(new EventEmitter(), {
      argv: [process.execPath, ...args], env: {}, pid: process.pid, execPath: process.execPath, platform: process.platform,
    });
    const sandbox = {
      process: simulatedProcess,
      console, Buffer, clearInterval,
      setInterval() { throw new Error('Health polling starts only after renderer readiness'); },
    };
    sandbox.global = sandbox;
    const localRequire = id => {
      if (id === 'electron') return {app, ipcMain, BrowserWindow: {fromWebContents() { return null; }, getAllWindows() { return windows; }}};
      if (id === 'electron-updater') return {autoUpdater: hostUpdater};
      if (id === './trusted-keys.json') return trustedKeys;
      if (path.isAbsolute(id) && id.endsWith(path.join('src', 'main.js'))) {
        loads.push({path: id, settings: fs.existsSync(settings) ? fs.readFileSync(settings, 'utf8') : null,
          version: sandbox.__busyShell.businessVersion});
        onBusinessLoad?.({app, process: simulatedProcess, lifecycle});
        return {};
      }
      return bootstrapRequire(id);
    };
    const module = {exports: {}};
    vm.runInNewContext(wrap(bootstrapSource), sandbox, {filename: bootstrapPath})(module.exports, localRequire, module, bootstrapPath, path.dirname(bootstrapPath));
    return {loads, exits, lifecycle, shell: sandbox.__busyShell, app, process: simulatedProcess};
  }

  return {base, userData, root, settings, builtin, store, journal, previous, candidate, prepare, worker, run};
}

test('normal startup restores interrupted candidate settings before loading the verified previous business', t => {
  const c = context(t);
  const transaction = c.prepare();
  fs.writeFileSync(c.settings, candidateSettings);
  const result = c.run();
  assert.deepEqual(result.exits, []);
  assert.deepEqual(result.loads, [{path: path.join(c.store.verify(c.previous).root, 'src/main.js'), settings: originalSettings, version: '1.4.1'}]);
  assert.equal(fs.readFileSync(c.settings, 'utf8'), originalSettings);
  assert.equal(fs.readFileSync(path.join(transaction.directory, 'failed-settings.json'), 'utf8'), candidateSettings);
  assert.equal(fs.readFileSync(transaction.backup, 'utf8'), originalSettings);
  assert.equal(c.journal.read().pending, null);
  assert.deepEqual(c.journal.read().current, c.previous);
  assert.match(c.journal.read().failures.at(-1).reason, /interrupted-candidate-boot/);
  assert.match(result.shell.recoveryMessage, /1\.4\.2.*1\.4\.1/);
  const second = c.run();
  assert.equal(second.loads[0].version, '1.4.1');
  assert.equal(c.journal.read().failures.length, 1);
  assert.equal(fs.readFileSync(path.join(transaction.directory, 'failed-settings.json'), 'utf8'), candidateSettings);
});

test('an interrupted candidate that created first-run settings preserves them before restoring their absence', t => {
  const c = context(t);
  const transaction = c.prepare({existed: false});
  fs.writeFileSync(c.settings, candidateSettings);
  const result = c.run();
  assert.deepEqual(result.exits, []);
  assert.equal(result.loads[0].version, '1.4.1');
  assert.equal(result.loads[0].settings, null);
  assert.equal(fs.existsSync(c.settings), false);
  assert.equal(fs.readFileSync(path.join(transaction.directory, 'failed-settings.json'), 'utf8'), candidateSettings);
  assert.equal(c.journal.read().pending, null);
});

test('an interrupted first business update restores settings before returning to the installed builtin', t => {
  const c = context(t, {acceptPrevious: false});
  const transaction = c.prepare();
  fs.writeFileSync(c.settings, candidateSettings);
  const result = c.run();
  assert.deepEqual(result.exits, []);
  assert.deepEqual(result.loads, [{path: path.join(repository, 'src/main.js'), settings: originalSettings, version: '1.4.0'}]);
  assert.equal(c.journal.read().current, null);
  assert.equal(c.journal.read().pending, null);
  assert.equal(fs.readFileSync(path.join(transaction.directory, 'failed-settings.json'), 'utf8'), candidateSettings);
});

test('a valid quiescent candidate can be recovered while its native process ID is still alive', t => {
  const c = context(t);
  const transaction = c.prepare({booting: false});
  c.journal.select(transaction.token);
  assert.equal(c.journal.read().pending.bootPid, process.pid);
  assert.equal(alive(process.pid), true);
  fs.writeFileSync(c.settings, candidateSettings);
  writeJson(path.join(c.root, 'shutdown-' + transaction.token + '-' + process.pid + '.json'), {
    token: transaction.token, pid: process.pid, phase: 'quiescent', at: Date.now(),
  });
  const result = c.run();
  assert.deepEqual(result.exits, []);
  assert.deepEqual(result.loads, [{path: path.join(c.store.verify(c.previous).root, 'src/main.js'), settings: originalSettings, version: '1.4.1'}]);
  assert.equal(c.journal.read().pending, null);
  assert.deepEqual(c.journal.read().current, c.previous);
  assert.equal(c.journal.read().failures.at(-1).reason, 'interrupted-candidate-boot');
  assert.equal(fs.readFileSync(path.join(transaction.directory, 'failed-settings.json'), 'utf8'), candidateSettings);
  assert.equal(alive(process.pid), true, 'Recovery must not terminate a process merely because its native cleanup is still running');
});

test('a live candidate without a shutdown marker cannot have its settings restored by another bootstrap', t => {
  const c = context(t);
  const transaction = c.prepare({booting: false});
  c.journal.select(transaction.token);
  fs.writeFileSync(c.settings, candidateSettings);
  const before = fs.readFileSync(path.join(c.root, 'journal.json'));
  const result = c.run();
  assert.deepEqual(result.exits, [1]);
  assert.deepEqual(result.loads, []);
  assert.equal(fs.readFileSync(c.settings, 'utf8'), candidateSettings);
  assert.deepEqual(fs.readFileSync(path.join(c.root, 'journal.json')), before);
  assert.equal(fs.existsSync(path.join(transaction.directory, 'failed-settings.json')), false);
});

test('stale or mismatched shutdown markers cannot declare a live candidate quiescent', t => {
  for (const invalid of ['token', 'pid', 'phase', 'stale', 'future']) {
    const c = context(t);
    const transaction = c.prepare({booting: false});
    c.journal.select(transaction.token);
    fs.writeFileSync(c.settings, candidateSettings);
    const marker = {token: transaction.token, pid: process.pid, phase: 'quiescent', at: Date.now()};
    if (invalid === 'token') marker.token = 'e'.repeat(48);
    if (invalid === 'pid') marker.pid = deadPid;
    if (invalid === 'phase') marker.phase = 'windows-closed';
    if (invalid === 'stale') marker.at = c.journal.read().pending.bootStartedAt - 1;
    if (invalid === 'future') marker.at = Date.now() + 60000;
    writeJson(path.join(c.root, 'shutdown-' + transaction.token + '-' + process.pid + '.json'), marker);
    const before = fs.readFileSync(path.join(c.root, 'journal.json'));
    const result = c.run();
    assert.deepEqual(result.exits, [1], invalid);
    assert.deepEqual(result.loads, [], invalid);
    assert.equal(fs.readFileSync(c.settings, 'utf8'), candidateSettings, invalid);
    assert.deepEqual(fs.readFileSync(path.join(c.root, 'journal.json')), before, invalid);
    assert.equal(fs.existsSync(path.join(transaction.directory, 'failed-settings.json')), false, invalid);
  }
});

test('a live supervisor still owns recovery even when its candidate has already reported quiescence', t => {
  const c = context(t);
  const transaction = c.prepare({booting: false});
  c.journal.select(transaction.token);
  c.worker(transaction.token);
  fs.writeFileSync(c.settings, candidateSettings);
  writeJson(path.join(c.root, 'shutdown-' + transaction.token + '-' + process.pid + '.json'), {
    token: transaction.token, pid: process.pid, phase: 'quiescent', at: Date.now(),
  });
  const before = fs.readFileSync(path.join(c.root, 'journal.json'));
  const result = c.run();
  assert.deepEqual(result.exits, [0]);
  assert.deepEqual(result.loads, []);
  assert.equal(fs.readFileSync(c.settings, 'utf8'), candidateSettings);
  assert.deepEqual(fs.readFileSync(path.join(c.root, 'journal.json')), before);
  assert.equal(fs.existsSync(path.join(transaction.directory, 'failed-settings.json')), false);
});

test('a live supervisor defers an ordinary duplicate startup without recovering or loading anything', t => {
  const c = context(t);
  const transaction = c.prepare();
  c.worker(transaction.token);
  fs.writeFileSync(c.settings, candidateSettings);
  const before = fs.readFileSync(path.join(c.root, 'journal.json'));
  const result = c.run();
  assert.deepEqual(result.exits, [0]);
  assert.deepEqual(result.loads, []);
  assert.equal(fs.readFileSync(c.settings, 'utf8'), candidateSettings);
  assert.deepEqual(fs.readFileSync(path.join(c.root, 'journal.json')), before);
  assert.equal(fs.existsSync(path.join(transaction.directory, 'failed-settings.json')), false);
});

test('an exact supervisor rollback token permits fallback loading while that supervisor remains alive', t => {
  const c = context(t);
  const transaction = c.prepare();
  c.journal.rollback(transaction.token, 'candidate exited');
  c.worker(transaction.token);
  const result = c.run({args: ['--business-rollback-token=' + transaction.token]});
  assert.deepEqual(result.exits, []);
  assert.equal(result.loads.length, 1);
  assert.equal(result.loads[0].version, '1.4.1');
  assert.equal(result.loads[0].settings, originalSettings);
  assert.deepEqual(c.journal.read().current, c.previous);
  assert.equal(c.journal.read().pending, null);
});

test('a rollback argument cannot bypass a live supervisor with the wrong token, PID or readiness marker', t => {
  for (const invalid of ['token', 'pid', 'ready']) {
    const c = context(t);
    const transaction = c.prepare({booting: false});
    c.worker(transaction.token, {markerPid: invalid === 'pid' ? deadPid : process.pid, markerReady: invalid !== 'ready'});
    const argument = invalid === 'token' ? 'f'.repeat(48) : transaction.token;
    const result = c.run({args: ['--business-rollback-token=' + argument]});
    assert.deepEqual(result.exits, [0], invalid);
    assert.deepEqual(result.loads, [], invalid);
    assert.equal(c.journal.read().pending.token, transaction.token, invalid);
  }
});

test('an orphan prepared transaction is cleared without restoring its older settings snapshot', t => {
  const c = context(t);
  const transaction = c.prepare({booting: false});
  const newerSettings = '{"schema":1,"userChoice":"changed-after-prepare"}';
  fs.writeFileSync(c.settings, newerSettings);
  const result = c.run();
  assert.deepEqual(result.exits, []);
  assert.equal(result.loads[0].settings, newerSettings);
  assert.equal(result.loads[0].version, '1.4.1');
  assert.equal(c.journal.read().pending, null);
  assert.equal(c.journal.read().failures.at(-1).reason, 'interrupted-before-handoff');
  assert.equal(fs.existsSync(path.join(transaction.directory, 'failed-settings.json')), false);
  assert.equal(fs.readFileSync(transaction.backup, 'utf8'), originalSettings);
});

test('invalid recovery token, root, target or backup path aborts before settings changes or business loading', t => {
  for (const invalid of ['token', 'root', 'target', 'backup', 'missing-record']) {
    const c = context(t);
    const transaction = c.prepare();
    fs.writeFileSync(c.settings, candidateSettings);
    const outside = path.join(c.base, 'outside.json');
    fs.writeFileSync(outside, 'unrelated bytes');
    if (invalid === 'token') transaction.config.token = 'e'.repeat(48);
    if (invalid === 'root') transaction.config.root = c.base;
    if (invalid === 'target') transaction.config.settingsBackup.target = outside;
    if (invalid === 'backup') transaction.config.settingsBackup.path = outside;
    if (invalid === 'missing-record') fs.unlinkSync(transaction.configPath);
    else writeJson(transaction.configPath, transaction.config);
    const before = fs.readFileSync(path.join(c.root, 'journal.json'));
    const result = c.run();
    assert.deepEqual(result.exits, [1], invalid);
    assert.deepEqual(result.loads, [], invalid);
    assert.equal(fs.readFileSync(c.settings, 'utf8'), candidateSettings, invalid);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'unrelated bytes', invalid);
    assert.deepEqual(fs.readFileSync(path.join(c.root, 'journal.json')), before, invalid);
    assert.equal(fs.existsSync(path.join(transaction.directory, 'failed-settings.json')), false, invalid);
  }
});

test('a malformed original-settings flag is rejected instead of deleting settings and loading a fallback', t => {
  for (const existed of [undefined, null, 0, 'false']) {
    const c = context(t);
    const transaction = c.prepare();
    transaction.config.settingsBackup.existed = existed;
    writeJson(transaction.configPath, transaction.config);
    fs.writeFileSync(c.settings, candidateSettings);
    const result = c.run();
    assert.deepEqual(result.exits, [1], String(existed));
    assert.deepEqual(result.loads, [], String(existed));
    assert.equal(fs.readFileSync(c.settings, 'utf8'), candidateSettings, String(existed));
    assert.equal(c.journal.read().pending.token, transaction.token, String(existed));
    assert.equal(fs.existsSync(path.join(transaction.directory, 'failed-settings.json')), false, String(existed));
  }
});

test('a junction beneath the transaction path cannot redirect settings recovery outside the transaction', t => {
  const c = context(t);
  const transaction = c.prepare();
  fs.writeFileSync(c.settings, candidateSettings);
  const outside = path.join(c.base, 'outside-transaction');
  fs.renameSync(transaction.directory, outside);
  try { fs.symlinkSync(outside, transaction.directory, 'junction'); } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) { t.skip('Directory symlink creation is unavailable: ' + error.code); return; }
    throw error;
  }
  const result = c.run();
  assert.deepEqual(result.exits, [1]);
  assert.deepEqual(result.loads, []);
  assert.equal(fs.readFileSync(c.settings, 'utf8'), candidateSettings);
  assert.equal(fs.existsSync(path.join(outside, 'failed-settings.json')), false);
  assert.equal(c.journal.read().pending.token, transaction.token);
});

test('missing old settings permit an absent snapshot file but never an absent transaction directory', t => {
  const c = context(t);
  const transaction = c.prepare({existed: false});
  assert.equal(fs.existsSync(transaction.backup), false);
  assert.equal(validateRecovery(transaction.config).target, path.join(c.userData, 'settings.json'));
  fs.unlinkSync(c.settings);
  assert.doesNotThrow(() => validateRecovery(transaction.config));
  fs.renameSync(transaction.directory, transaction.directory + '-moved');
  assert.throws(() => validateRecovery(transaction.config), error => error.code === 'ENOENT');
  assert.equal(fs.existsSync(transaction.directory), false);
  assert.equal(fs.existsSync(c.settings), false);
});

test('a required missing snapshot or a settings directory aborts without creating a failed-settings copy', t => {
  for (const invalid of ['missing-backup', 'settings-directory']) {
    const c = context(t);
    const transaction = c.prepare();
    fs.writeFileSync(c.settings, candidateSettings);
    if (invalid === 'missing-backup') fs.unlinkSync(transaction.backup);
    else {
      fs.renameSync(c.settings, c.settings + '.kept');
      fs.mkdirSync(c.settings);
    }
    const result = c.run();
    assert.deepEqual(result.exits, [1], invalid);
    assert.deepEqual(result.loads, [], invalid);
    assert.equal(fs.existsSync(path.join(transaction.directory, 'failed-settings.json')), false, invalid);
    assert.equal(c.journal.read().pending.token, transaction.token, invalid);
    if (invalid === 'missing-backup') assert.equal(fs.readFileSync(c.settings, 'utf8'), candidateSettings);
    else assert.equal(fs.readFileSync(c.settings + '.kept', 'utf8'), candidateSettings);
  }
});

test('an already-owned application instance exits before touching the update journal', t => {
  const c = context(t);
  c.prepare();
  fs.writeFileSync(c.settings, candidateSettings);
  const before = fs.readFileSync(path.join(c.root, 'journal.json'));
  const result = c.run({singleInstance: false});
  assert.deepEqual(result.lifecycle.filter(event => event[0] === 'quit'), [['quit']]);
  assert.deepEqual(result.exits, []);
  assert.deepEqual(result.loads, []);
  assert.deepEqual(fs.readFileSync(path.join(c.root, 'journal.json')), before);
  assert.equal(fs.readFileSync(c.settings, 'utf8'), candidateSettings);
});

test('before-quit never reports quiescence even after the Node exit event', t => {
  const c = context(t);
  const transaction = c.prepare({booting: false});
  const result = c.run({args: ['--business-update-token=' + transaction.token]});
  const marker = path.join(c.root, 'shutdown-' + transaction.token + '-' + process.pid + '.json');
  result.app.emit('before-quit');
  result.process.emit('exit', 0);
  result.app.emit('before-quit');
  assert.equal(fs.existsSync(marker), false);
  assert.equal(result.lifecycle.some(event => event[0] === 'release-lock'), false);
});

test('app quit cannot release the lock or write a marker before Node has exited', t => {
  const c = context(t);
  const transaction = c.prepare({booting: false});
  const result = c.run({args: ['--business-update-token=' + transaction.token]});
  const marker = path.join(c.root, 'shutdown-' + transaction.token + '-' + process.pid + '.json');
  result.app.emit('quit');
  assert.equal(fs.existsSync(marker), false);
  assert.equal(result.lifecycle.some(event => event[0] === 'release-lock'), false);
  result.process.emit('exit', 0);
  assert.equal(fs.existsSync(marker), false, 'The Node exit signal alone cannot substitute for the app quit event');
});

test('remaining BrowserWindows prevent a quiescent marker even after Node exit and app quit', t => {
  const c = context(t);
  const transaction = c.prepare({booting: false});
  const result = c.run({args: ['--business-update-token=' + transaction.token], windows: [{}]});
  result.process.emit('exit', 0);
  result.app.emit('quit');
  assert.equal(fs.existsSync(path.join(c.root, 'shutdown-' + transaction.token + '-' + process.pid + '.json')), false);
  assert.equal(result.lifecycle.some(event => event[0] === 'release-lock'), false);
});

test('a token-bound closed application releases its lock before atomically reporting quiescence', t => {
  const c = context(t);
  const transaction = c.prepare({booting: false});
  const marker = path.join(c.root, 'shutdown-' + transaction.token + '-' + process.pid + '.json');
  const result = c.run({
    args: ['--business-update-token=' + transaction.token],
    onRelease() { assert.equal(fs.existsSync(marker), false, 'The marker must not precede releasing the old instance lock'); },
    onBusinessLoad({app, lifecycle}) {
      app.on('quit', () => {
        assert.equal(fs.existsSync(marker), false, 'The shell registers its quit callback after business callbacks');
        lifecycle.push(['business-quit']);
      });
    },
  });
  const before = fs.readFileSync(path.join(c.root, 'journal.json'));
  const earliest = Date.now();
  result.process.emit('exit', 0);
  result.app.emit('quit');
  const reported = JSON.parse(fs.readFileSync(marker, 'utf8'));
  assert.equal(reported.token, transaction.token);
  assert.equal(reported.pid, process.pid);
  assert.equal(reported.phase, 'quiescent');
  assert.ok(Number.isFinite(reported.at) && reported.at >= earliest && reported.at <= Date.now());
  assert.equal(result.lifecycle.filter(event => event[0] === 'release-lock').length, 1);
  assert.ok(result.lifecycle.findIndex(event => event[0] === 'business-quit') < result.lifecycle.findIndex(event => event[0] === 'release-lock'));
  assert.deepEqual(fs.readFileSync(path.join(c.root, 'journal.json')), before);
  assert.equal(fs.readdirSync(c.root).some(name => name.startsWith('shutdown-') && name.endsWith('.tmp')), false);
});

test('normal application exit without an update token produces no shutdown marker', t => {
  const c = context(t);
  const result = c.run();
  result.process.emit('exit', 0);
  result.app.emit('quit');
  assert.equal(fs.readdirSync(c.root).some(name => name.startsWith('shutdown-')), false);
  assert.equal(result.lifecycle.some(event => event[0] === 'release-lock'), false);
});

test('a partially loaded candidate retains the guarded shutdown handshake after startup throws', t => {
  const c = context(t);
  const transaction = c.prepare({booting: false});
  const marker = path.join(c.root, 'shutdown-' + transaction.token + '-' + process.pid + '.json');
  const result = c.run({args: ['--business-update-token=' + transaction.token], onBusinessLoad() { throw new Error('Candidate startup failed'); }});
  assert.deepEqual(result.exits, [1]);
  assert.equal(fs.existsSync(marker), false);
  result.app.emit('quit');
  assert.equal(fs.existsSync(marker), false);
  result.process.emit('exit', 1);
  result.app.emit('quit');
  assert.equal(JSON.parse(fs.readFileSync(marker, 'utf8')).phase, 'quiescent');
  assert.equal(result.lifecycle.filter(event => event[0] === 'release-lock').length, 1);
  assert.equal(c.journal.read().pending.token, transaction.token);
});

test('a duplicate that never owned the instance lock cannot publish a shutdown handshake', t => {
  const c = context(t);
  const transaction = c.prepare({booting: false});
  const result = c.run({args: ['--business-update-token=' + transaction.token], singleInstance: false});
  result.process.emit('exit', 0);
  result.app.emit('quit');
  assert.equal(fs.readdirSync(c.root).some(name => name.startsWith('shutdown-')), false);
  assert.equal(result.lifecycle.some(event => event[0] === 'release-lock'), false);
  assert.deepEqual(result.loads, []);
});
