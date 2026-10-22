'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createJournal, alive, acquireLock, writeJson } = require('../shell/journal.cjs');
const { createStore } = require('./fixtures/restart-supervisor/store.cjs');
const { validateConfig, cleanArgs, restoreSettings } = require('../shell/restart-worker.cjs');
const fixture = path.join(__dirname, 'fixtures', 'restart-supervisor');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function context(t, behavior = 'success') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'busy-supervisor-test-'));
  const builtin = { root: path.join(root, 'builtin'), version: '1.4.0' };
  fs.mkdirSync(builtin.root);
  const store = createStore({ root });
  const journal = createJournal({ root, builtin, store });
  const children = [];
  t.after(async () => {
    const pids = [...events(root).map(item => item.pid), ...children.map(child => child.pid)].filter(Boolean);
    for (const pid of new Set(pids)) {
      try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await sleep(80);
    fs.rmSync(root, { recursive: true, force: true });
  });
  function version(value, hash = 'a') {
    const descriptor = { id: `${value}-${hash.repeat(16)}`, version: value, manifestHash: hash.repeat(64) };
    const directory = path.join(root, 'versions', descriptor.id);
    fs.mkdirSync(directory, { recursive: true });
    writeJson(path.join(directory, 'valid.json'), descriptor);
    return descriptor;
  }
  function accept(value) {
    const token = journal.prepare(value);
    journal.select(token);
    journal.ready(token, process.pid);
    journal.confirm(token);
  }
  const configPath = path.join(root, 'config.json');
  const config = { root, builtin, shellVersion: '1.4.0', shellApi: 1, trustedKeys: {}, oldPid: 0,
    executable: process.execPath, args: [path.join(fixture, 'app.cjs'), configPath], cwd: root, behavior,
    timeouts: { oldExitMs: 400, healthMs: 1500, stableMs: 140, pollMs: 10, terminationMs: 500 },
    updatingMarker: path.join(root, 'user-data', 'updating') };
  function prepare() {
    config.token = journal.prepare(version('1.4.2', 'b'));
    fs.mkdirSync(path.dirname(config.updatingMarker), { recursive: true });
    fs.writeFileSync(config.updatingMarker, 'updating');
    writeJson(configPath, config);
    return config.token;
  }
  async function run() {
    writeJson(configPath, config);
    const child = spawn(process.execPath, [path.join(fixture, 'worker.cjs'), configPath],
      { cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    children.push(child);
    let stderr = '';
    child.stderr.on('data', bytes => { stderr += bytes; });
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        let log = '';
        try { log = fs.readFileSync(path.join(root, 'update.log'), 'utf8'); } catch { /* startup failed before log */ }
        reject(new Error(`Supervisor did not exit:\n${stderr}\n${log}`));
      }, 8000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); resolve(code); });
    });
    assert.equal(code, 0, stderr);
    return JSON.parse(fs.readFileSync(path.join(root, 'result.json'), 'utf8'));
  }
  return { root, builtin, journal, store, config, configPath, children, version, accept, prepare, run };
}

function events(root) {
  try { return fs.readFileSync(path.join(root, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

async function until(predicate, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Fixture wait timed out'); await sleep(10); }
}

test('prepared payload is inert until its exact token boots; only health confirmation changes current', async t => {
  const c = context(t);
  c.accept(c.version('1.4.1'));
  const old = c.journal.read().current;
  const token = c.prepare();
  assert.equal(c.journal.select().version, '1.4.1');
  assert.deepEqual(c.journal.read().current, old);
  assert.throws(() => c.journal.select('f'.repeat(48)), { code: 'INVALID_UPDATE_TOKEN' });
  assert.equal(c.journal.select(token).version, '1.4.2');
  assert.deepEqual(c.journal.read().current, old);
  assert.throws(() => c.journal.select(), { code: 'UPDATE_IN_PROGRESS' });
  assert.throws(() => c.journal.confirm(token), { code: 'INVALID_HEALTH_SIGNAL' });
  assert.throws(() => c.journal.ready(token, process.pid + 1), { code: 'INVALID_HEALTH_SIGNAL' });
  c.journal.ready(token, process.pid);
  c.journal.confirm(token);
  assert.equal(c.journal.read().current.version, '1.4.2');
  assert.equal(c.journal.read().previous.version, '1.4.1');
  assert.equal(c.journal.read().pending, null);
  assert.throws(() => c.journal.select(token), { code: 'INVALID_UPDATE_TOKEN' });
});

test('real supervisor promotes a ready candidate that stays alive and clears updating marker', { timeout: 10000 }, async t => {
  const c = context(t);
  c.accept(c.version('1.4.1'));
  const token = c.prepare();
  const result = await c.run();
  assert.equal(result.status, 'confirmed', fs.readFileSync(path.join(c.root, 'update.log'), 'utf8'));
  assert.ok(alive(result.pid));
  assert.equal(c.journal.read().current.version, '1.4.2');
  assert.equal(c.journal.read().previous.version, '1.4.1');
  const marker = JSON.parse(fs.readFileSync(path.join(c.root, `handoff-${token}.json`)));
  assert.equal(marker.ready, true);
  assert.equal(marker.token, token);
  assert.equal(events(c.root).filter(event => event.event === 'candidate').length, 1);
  assert.equal(events(c.root)[0].runAsNode, null);
  assert.equal(fs.existsSync(c.config.updatingMarker), false);
});

for (const behavior of ['crash', 'timeout', 'ready-crash', 'bad-health']) {
  test(`real ${behavior} candidate rolls back once and retains user data`, { timeout: 10000 }, async t => {
    const c = context(t, behavior);
    c.accept(c.version('1.4.1'));
    c.prepare();
    const data = path.join(c.root, 'user-data', 'unrelated-history.json');
    fs.writeFileSync(data, '{"keep":true}');
    const result = await c.run();
    assert.equal(result.status, 'rolled-back');
    assert.equal(c.journal.read().current.version, '1.4.1');
    assert.equal(c.journal.read().pending, null);
    assert.equal(c.journal.read().failures.length, 1);
    const recorded = events(c.root);
    assert.equal(recorded.filter(event => event.event === 'candidate').length, 1);
    assert.equal(recorded.filter(event => event.event === 'fallback').length, 1);
    assert.equal(recorded.find(event => event.event === 'fallback').version, '1.4.1');
    assert.equal(alive(recorded.find(event => event.event === 'candidate').pid), false);
    assert.equal(fs.readFileSync(data, 'utf8'), '{"keep":true}');
    const log = fs.readFileSync(path.join(c.root, 'update.log'), 'utf8');
    assert.match(log, /update-failed/);
    assert.match(log, /fallback-started/);
    assert.ok(log.indexOf('candidate-exit') < log.indexOf('fallback-started'), log);
    if (behavior === 'crash') assert.match(log, /"code":17/);
  });
}

test('old process timeout cancels without killing or restarting it and never restores active settings', { timeout: 10000 }, async t => {
  const c = context(t);
  c.prepare();
  const transaction = path.join(c.root, 'transactions', c.config.token);
  fs.mkdirSync(transaction, { recursive: true });
  const target = path.join(c.root, 'user-data', 'settings.json');
  const backup = path.join(transaction, 'settings.json');
  fs.writeFileSync(target, '{"live":2}');
  fs.writeFileSync(backup, '{"live":1}');
  c.config.settingsBackup = { path: backup, target, existed: true };
  const old = spawn(process.execPath, [path.join(fixture, 'app.cjs'), c.configPath, '--hold-old'], { stdio: 'ignore', windowsHide: true });
  c.children.push(old);
  await until(() => events(c.root).some(event => event.event === 'old'));
  c.config.oldPid = old.pid;
  const result = await c.run();
  assert.equal(result.status, 'cancelled');
  assert.equal(result.reason, 'old-process-exit-timeout');
  assert.ok(alive(old.pid));
  assert.equal(events(c.root).length, 1);
  assert.equal(c.journal.read().current, null);
  assert.equal(c.journal.read().pending, null);
  assert.equal(fs.readFileSync(target, 'utf8'), '{"live":2}');
});

test('failed candidate settings are preserved before restoring the previous schema', { timeout: 10000 }, async t => {
  const c = context(t, 'crash');
  c.accept(c.version('1.4.1'));
  c.prepare();
  const transaction = path.join(c.root, 'transactions', c.config.token);
  fs.mkdirSync(transaction, { recursive: true });
  const target = path.join(c.root, 'user-data', 'settings.json');
  const backup = path.join(transaction, 'settings.json');
  fs.writeFileSync(target, '{"schema":1,"user":"kept"}');
  fs.copyFileSync(target, backup);
  c.config.settingsBackup = { path: backup, target, existed: true };
  c.config.dirtySettings = true;
  assert.equal((await c.run()).status, 'rolled-back');
  assert.equal(fs.readFileSync(target, 'utf8'), '{"schema":1,"user":"kept"}');
  assert.equal(fs.readFileSync(path.join(transaction, 'failed-settings.json'), 'utf8'), '{"schema":99}');
  assert.equal(events(c.root).find(item => item.event === 'fallback').settings, '{"schema":1,"user":"kept"}');
  restoreSettings(c.config, () => {});
  assert.equal(fs.readFileSync(path.join(transaction, 'failed-settings.json'), 'utf8'), '{"schema":99}');
});

test('old process handle is acquired before handoff, and candidate starts after old process exits', { timeout: 10000 }, async t => {
  const c = context(t);
  const token = c.prepare();
  const old = spawn(process.execPath, [path.join(fixture, 'app.cjs'), c.configPath, '--hold-old'], { stdio: 'ignore', windowsHide: true });
  c.children.push(old);
  await until(() => events(c.root).some(event => event.event === 'old'));
  c.config.oldPid = old.pid;
  c.config.timeouts.oldExitMs = 3000;
  const running = c.run();
  await until(() => fs.existsSync(path.join(c.root, `handoff-${token}.json`)));
  assert.equal(events(c.root).filter(item => item.event === 'candidate').length, 0);
  const exited = new Promise(resolve => old.once('exit', resolve));
  old.kill('SIGTERM');
  await exited;
  assert.equal((await running).status, 'confirmed');
  const log = fs.readFileSync(path.join(c.root, 'update.log'), 'utf8');
  if (process.platform === 'win32') assert.match(log, /win32-process-handle/);
  assert.ok(log.indexOf('old-process-exited') < log.indexOf('candidate-started'));
});

test('missing original settings are restored by preserving and removing candidate-created settings', { timeout: 10000 }, async t => {
  const c = context(t, 'crash');
  c.prepare();
  const transaction = path.join(c.root, 'transactions', c.config.token);
  fs.mkdirSync(transaction, { recursive: true });
  const target = path.join(c.root, 'user-data', 'settings.json');
  c.config.settingsBackup = { path: path.join(transaction, 'settings.json'), target, existed: false };
  c.config.dirtySettings = true;
  assert.equal((await c.run()).status, 'rolled-back');
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.readFileSync(path.join(transaction, 'failed-settings.json'), 'utf8'), '{"schema":99}');
  assert.equal(events(c.root).find(item => item.event === 'fallback').settings, null);
});

test('settings restoration failure retains the pending recovery entry and never starts old business code', { timeout: 10000 }, async t => {
  const c = context(t, 'crash');
  c.prepare();
  const transaction = path.join(c.root, 'transactions', c.config.token);
  fs.mkdirSync(transaction, { recursive: true });
  const target = path.join(c.root, 'user-data', 'settings.json');
  const backup = path.join(transaction, 'settings.json');
  fs.writeFileSync(target, '{"schema":1}');
  fs.copyFileSync(target, backup);
  c.config.settingsBackup = { path: backup, target, existed: true };
  c.config.dirtySettings = true;
  c.config.removeBackup = true;
  assert.equal((await c.run()).status, 'rollback-failed');
  assert.equal(c.journal.read().pending.token, c.config.token);
  assert.equal(events(c.root).filter(item => item.event === 'fallback').length, 0);
  assert.equal(fs.readFileSync(target, 'utf8'), '{"schema":99}');
});

test('fallback must report readiness; its health timeout stops it without another retry', { timeout: 10000 }, async t => {
  const c = context(t, 'crash');
  c.prepare();
  c.config.fallbackTimeout = true;
  const result = await c.run();
  assert.equal(result.status, 'rollback-failed');
  assert.equal(result.reason, 'fallback-health-timeout');
  const fallbacks = events(c.root).filter(item => item.event === 'fallback');
  assert.equal(fallbacks.length, 1);
  assert.equal(alive(fallbacks[0].pid), false);
});

test('a process that stops heartbeating after ready is not promoted merely for staying alive', { timeout: 10000 }, async t => {
  const c = context(t);
  c.prepare();
  c.config.timeouts.stableMs = 3000;
  c.config.timeouts.healthMs = 4200;
  assert.equal((await c.run()).status, 'rolled-back');
  assert.equal(c.journal.read().current, null);
});

test('fresh heartbeats permit the full three-second stability window', { timeout: 10000 }, async t => {
  const c = context(t);
  c.prepare();
  c.config.heartbeat = true;
  c.config.timeouts.stableMs = 3000;
  c.config.timeouts.healthMs = 5000;
  assert.equal((await c.run()).status, 'confirmed');
  assert.equal(c.journal.read().current.version, '1.4.2');
});

test('spawn failure preserves known-good state and records both candidate and fallback launch errors', { timeout: 10000 }, async t => {
  const c = context(t);
  c.accept(c.version('1.4.1'));
  c.prepare();
  c.config.cwd = path.join(c.root, 'missing-directory');
  assert.equal((await c.run()).status, 'rollback-failed');
  assert.equal(c.journal.read().current.version, '1.4.1');
  assert.equal(c.journal.read().pending, null);
  assert.equal(events(c.root).length, 0);
  assert.match(fs.readFileSync(path.join(c.root, 'update.log'), 'utf8'), /fallback-start-failed/);
});

test('corrupt current falls back to a verified previous version and then builtin', async t => {
  const c = context(t);
  const first = c.version('1.4.1');
  const second = c.version('1.4.2', 'b');
  c.accept(first);
  c.accept(second);
  fs.unlinkSync(path.join(c.root, 'versions', second.id, 'valid.json'));
  assert.equal(c.journal.select().version, '1.4.1');
  fs.unlinkSync(path.join(c.root, 'versions', first.id, 'valid.json'));
  assert.equal(c.journal.select().root, c.builtin.root);
  assert.equal(c.journal.read().failures.length, 2);
});

test('newer installed builtin supersedes old cache while preserving a previous descriptor', async t => {
  const c = context(t);
  c.accept(c.version('1.4.1'));
  const newer = createJournal({ root: c.root, builtin: { ...c.builtin, version: '1.5.0' }, store: c.store });
  assert.equal(newer.select().version, '1.5.0');
  assert.equal(newer.read().current, null);
  assert.equal(newer.read().previous.version, '1.4.1');
});

test('corrupt journal is backed up before builtin recovery', async t => {
  const c = context(t);
  fs.writeFileSync(path.join(c.root, 'journal.json'), '{bad state');
  assert.equal(c.journal.select().version, '1.4.0');
  const backup = fs.readdirSync(c.root).find(name => name.startsWith('journal.json.corrupt-'));
  assert.equal(fs.readFileSync(path.join(c.root, backup), 'utf8'), '{bad state');
  assert.match(fs.readFileSync(path.join(c.root, 'update.log'), 'utf8'), /journal-corrupt/);
});

test('failed atomic replacement never changes the previous journal bytes', async t => {
  const c = context(t);
  c.accept(c.version('1.4.1'));
  const before = fs.readFileSync(path.join(c.root, 'journal.json'));
  const value = c.version('1.4.2', 'b');
  const rename = fs.renameSync;
  fs.renameSync = (source, target) => {
    if (target === path.join(c.root, 'journal.json')) throw Object.assign(new Error('simulated write failure'), { code: 'EIO' });
    return rename(source, target);
  };
  try { assert.throws(() => c.journal.prepare(value), /simulated write failure/); }
  finally { fs.renameSync = rename; }
  assert.deepEqual(fs.readFileSync(path.join(c.root, 'journal.json')), before);
});

test('stale boot and expired prepared token are not retried; external paths are rejected', async t => {
  const c = context(t);
  const token = c.prepare();
  let state = c.journal.read();
  state.pending.status = 'booting';
  state.pending.bootPid = 2147483647;
  writeJson(path.join(c.root, 'journal.json'), state);
  assert.equal(c.journal.select().version, '1.4.0');
  assert.equal(c.journal.read().pending, null);
  assert.throws(() => c.journal.select(token), { code: 'INVALID_UPDATE_TOKEN' });
  c.prepare();
  state = c.journal.read();
  state.pending.preparedAt -= 48 * 60 * 60 * 1000;
  writeJson(path.join(c.root, 'journal.json'), state);
  assert.equal(c.journal.select().version, '1.4.0');
  assert.equal(c.journal.read().pending, null);
  assert.throws(() => c.journal.prepare({ ...c.version('1.4.3'), root: os.tmpdir() }), { code: 'INVALID_DESCRIPTOR' });
});

test('supervisor lock excludes a second owner and reclaims only a dead owner', async t => {
  const c = context(t);
  const lock = path.join(c.root, 'test.lock');
  const unlock = acquireLock(lock);
  assert.throws(() => acquireLock(lock), { code: 'UPDATE_LOCKED' });
  unlock();
  fs.mkdirSync(lock);
  writeJson(path.join(lock, 'owner.json'), { pid: 2147483647, nonce: 'old', at: 1 });
  const release = acquireLock(lock);
  assert.equal(JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'))).pid, process.pid);
  release();
});

test('launch config rejects another executable or env override and removes stale token arguments', async t => {
  const c = context(t);
  c.prepare();
  assert.throws(() => validateConfig({ ...c.config, executable: path.join(c.root, 'other.exe') }), /Invalid/);
  assert.throws(() => validateConfig({ ...c.config, env: { ELECTRON_RUN_AS_NODE: '1' } }), /environment/);
  assert.deepEqual(cleanArgs(['.', '--preview', '--business-update-token=old', '--profile=x', '--business-update-token', 'old2',
    '--business-rollback-token=older', '--business-rollback-token', 'older2']),
    ['.', '--preview', '--profile=x']);
});
