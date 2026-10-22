'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createJournal, atomicWrite, writeJson, acquireLock, alive } = require('./journal.cjs');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const samePath = (left, right) => process.platform === 'win32'
  ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
  : path.resolve(left) === path.resolve(right);

function watchProcess(pid) {
  if (!pid) return { exited: () => true, close() {}, mechanism: 'none' };
  if (process.platform !== 'win32') return { exited: () => !alive(pid), close() {}, mechanism: 'pid' };
  const kernel = require('koffi').load('kernel32.dll');
  const open = kernel.func('void * __stdcall OpenProcess(uint32 access, int inherit, uint32 pid)');
  const wait = kernel.func('uint32 __stdcall WaitForSingleObject(void *handle, uint32 milliseconds)');
  const close = kernel.func('int __stdcall CloseHandle(void *handle)');
  const lastError = kernel.func('uint32 __stdcall GetLastError()');
  const handle = open(0x00100000, 0, pid); // SYNCHRONIZE; no termination access.
  if (!handle) {
    const code = lastError();
    if (code === 87) return { exited: () => true, close() {}, mechanism: 'already-exited' };
    throw new Error(`Cannot observe old process exit: OpenProcess failed (${code})`);
  }
  let closed = false;
  return {
    mechanism: 'win32-process-handle',
    exited() {
      const result = wait(handle, 0);
      if (result === 0) return true;
      if (result === 0x102) return false;
      throw new Error(`Cannot observe old process exit: WaitForSingleObject failed (${lastError()})`);
    },
    close() { if (!closed) { close(handle); closed = true; } },
  };
}

function validateConfig(config) {
  if (!config || !path.isAbsolute(config.root || '') || !config.builtin
    || !path.isAbsolute(config.builtin.root || '') || typeof config.builtin.version !== 'string'
    || !/^[a-f0-9]{48}$/.test(config.token || '')
    || !path.isAbsolute(config.executable || '') || !samePath(config.executable, process.execPath)
    || !Array.isArray(config.args) || config.args.some(arg => typeof arg !== 'string')
    || !Number.isInteger(config.oldPid) || config.oldPid < 0 || config.oldPid === process.pid
    || (config.cwd !== undefined && !path.isAbsolute(config.cwd))) {
    throw new Error('Invalid restart supervisor configuration');
  }
  if (config.env !== undefined) throw new Error('Restart supervisor does not accept environment overrides');
  if (config.updatingMarker !== undefined && !path.isAbsolute(config.updatingMarker)) {
    throw new Error('Updating marker must be an absolute local path');
  }
  if (config.settingsBackup) {
    const backup = config.settingsBackup;
    const expected = path.join(config.root, 'transactions', config.token, 'settings.json');
    if (!path.isAbsolute(backup.path || '') || !samePath(backup.path, expected)
      || !path.isAbsolute(backup.target || '') || typeof backup.existed !== 'boolean'
      || samePath(backup.path, backup.target)) throw new Error('Invalid settings backup paths');
    if (backup.existed && !fs.statSync(backup.path).isFile()) throw new Error('Missing settings backup');
  }
  return config;
}

function cleanArgs(args) {
  const result = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--business-update-token' || args[index] === '--business-rollback-token') { index += 1; continue; }
    if (!args[index].startsWith('--business-update-token=') && !args[index].startsWith('--business-rollback-token=')) result.push(args[index]);
  }
  return result;
}

function timings(config) {
  const defaults = { oldExitMs: 30000, healthMs: 60000, stableMs: 3000, pollMs: 100, terminationMs: 5000 };
  for (const key of Object.keys(defaults)) {
    const value = config.timeouts?.[key];
    if (value !== undefined) {
      if (!Number.isFinite(value) || value < 1 || value > 120000) throw new Error(`Invalid timeout: ${key}`);
      defaults[key] = value;
    }
  }
  return defaults;
}

function logger(root, token) {
  fs.mkdirSync(root, { recursive: true });
  return (event, details = {}) => {
    const fd = fs.openSync(path.join(root, 'update.log'), 'a', 0o600);
    try {
      fs.writeSync(fd, `${JSON.stringify({ at: new Date().toISOString(), token, supervisorPid: process.pid, event, ...details })}\n`);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
  };
}

function start(config, token, log) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const args = cleanArgs(config.args);
  if (token) args.push(`--business-update-token=${token}`);
  else args.push(`--business-rollback-token=${config.token}`);
  const child = spawn(config.executable, args, { cwd: config.cwd || path.dirname(config.executable), env,
    detached: true, windowsHide: false, stdio: 'ignore' });
  // Install the handler immediately; spawn errors otherwise terminate the supervisor.
  child.on('error', cause => { child.spawnError = cause; });
  child.exited = false;
  child.on('exit', (code, signal) => {
    child.exited = true;
    log(token ? 'candidate-exit' : 'fallback-exit', { pid: child.pid, code, signal });
  });
  return child;
}

async function spawned(child) {
  if (child.spawnError) throw child.spawnError;
  if (child.pid) return;
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
}

function childAlive(child) {
  return child && !child.spawnError && child.exitCode === null && child.signalCode === null && alive(child.pid);
}

async function stopCandidate(child, time, log, role = 'candidate') {
  if (!child || !child.pid) return true;
  if (child.exited) return true;
  if (childAlive(child)) {
    log(`${role}-stop-requested`, { pid: child.pid });
    child.kill('SIGTERM');
  }
  let deadline = Date.now() + time.terminationMs;
  while (!child.exited && Date.now() < deadline) await sleep(time.pollMs);
  if (!child.exited) {
    log(`${role}-force-stop`, { pid: child.pid });
    // Only this ChildProcess is signalled; no process-name or process-tree kill is used.
    child.kill('SIGKILL');
    deadline = Date.now() + time.terminationMs;
    while (!child.exited && Date.now() < deadline) await sleep(time.pollMs);
  }
  return child.exited;
}

async function waitForFallback(child, expectedVersion, startedAt, config, time, log) {
  const deadline = Date.now() + time.healthMs;
  for (;;) {
    if (!childAlive(child)) throw new Error(`fallback-exited: code=${child.exitCode}, signal=${child.signalCode}`);
    try {
      const marker = JSON.parse(fs.readFileSync(path.join(config.root, 'runtime-ready.json'), 'utf8'));
      if (marker.pid === child.pid && marker.version === expectedVersion && marker.at >= startedAt) {
        log('fallback-ready', { pid: child.pid, version: expectedVersion });
        return;
      }
    } catch (cause) { if (cause.code !== 'ENOENT' && !(cause instanceof SyntaxError)) throw cause; }
    if (Date.now() >= deadline) throw new Error('fallback-health-timeout');
    await sleep(time.pollMs);
  }
}

function restoreSettings(config, log) {
  if (!config.settingsBackup) return;
  const { path: backup, target, existed } = config.settingsBackup;
  try {
    const failed = fs.readFileSync(target);
    const failedBackup = path.join(path.dirname(backup), 'failed-settings.json');
    if (!fs.existsSync(failedBackup)) atomicWrite(failedBackup, failed);
  } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
  if (existed) atomicWrite(target, fs.readFileSync(backup));
  else {
    try { fs.unlinkSync(target); } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
  }
  log('settings-restored', { existed });
}

async function runSupervisor(input, dependencies = {}) {
  const config = validateConfig(input);
  const time = timings(config);
  const log = logger(config.root, config.token);
  const unlock = acquireLock(path.join(config.root, 'supervisor.lock'));
  let candidate = null;
  let oldExited = false;
  let handedOff = false;
  let committed = false;
  let journal;
  let oldProcess;
  try {
    const makeStore = dependencies.createStore || require('./store.cjs').createStore;
    const store = makeStore({ root: config.root, trustedKeys: config.trustedKeys,
      shellVersion: config.shellVersion, shellApi: config.shellApi ?? 1 });
    journal = createJournal({ root: config.root, builtin: config.builtin, store });
    const pending = journal.read().pending;
    if (!pending || pending.token !== config.token || pending.status !== 'prepared') {
      throw new Error('Transaction is not prepared for this supervisor');
    }
    store.verify(pending.descriptor);
    // Acquire the Windows handle before telling the old application it may quit.
    oldProcess = watchProcess(config.oldPid);
    writeJson(path.join(config.root, `handoff-${config.token}.json`),
      { token: config.token, pid: process.pid, ready: true, at: Date.now() });
    handedOff = true;
    log('handoff-ready', { oldPid: config.oldPid, exitObservation: oldProcess.mechanism });
    const oldDeadline = Date.now() + time.oldExitMs;
    while (!oldProcess.exited()) {
      if (Date.now() >= oldDeadline) throw new Error('old-process-exit-timeout');
      await sleep(time.pollMs);
    }
    oldExited = true;
    log('old-process-exited', { oldPid: config.oldPid });
    candidate = start(config, config.token, log);
    await spawned(candidate);
    log('candidate-started', { pid: candidate.pid });
    const healthDeadline = Date.now() + time.healthMs;
    let healthySince = null;
    for (;;) {
      if (!childAlive(candidate)) {
        throw new Error(`candidate-exited: code=${candidate.exitCode}, signal=${candidate.signalCode}, error=${candidate.spawnError?.message || ''}`);
      }
      const signal = journal.readHealth(config.token);
      const pendingNow = journal.read().pending;
      if (signal && signal.pid === candidate.pid && pendingNow?.token === config.token
        && pendingNow.bootPid === candidate.pid && signal.manifestHash === pendingNow.descriptor.manifestHash
        && signal.at >= pendingNow.bootStartedAt && signal.at >= Date.now() - 2500) {
        if (healthySince === null) {
          healthySince = Date.now();
          log('candidate-ready', { pid: candidate.pid });
        }
        if (Date.now() - healthySince >= time.stableMs) break;
      } else healthySince = null;
      if (Date.now() >= healthDeadline) throw new Error('candidate-health-timeout');
      await sleep(time.pollMs);
    }
    journal.confirm(config.token);
    committed = true;
    log('candidate-confirmed', { pid: candidate.pid });
    candidate.unref();
    return { status: 'confirmed', pid: candidate.pid };
  } catch (cause) {
    log('update-failed', { reason: cause.message, code: cause.code || null, oldExited, handedOff });
    if (committed) throw cause;
    const stopped = await stopCandidate(candidate, time, log);
    if (!stopped) {
      log('rollback-blocked-candidate-alive', { pid: candidate.pid });
      candidate.unref();
      return { status: 'blocked', reason: cause.message, pid: candidate.pid };
    }
    if (!oldExited) {
      if (journal) journal.rollback(config.token, cause.message);
      return { status: 'cancelled', reason: cause.message };
    }
    let fallback;
    try {
      restoreSettings(config, log);
      const selected = journal ? journal.rollback(config.token, cause.message) : config.builtin;
      const startedAt = Date.now();
      fallback = start(config, null, log);
      await spawned(fallback);
      log('fallback-started', { pid: fallback.pid });
      // The fallback is attempted once. Keep observing its real application readiness.
      fallback.unref();
      await waitForFallback(fallback, selected.version, startedAt, config, time, log);
      return { status: 'rolled-back', reason: cause.message, pid: fallback.pid };
    } catch (fallbackError) {
      log('fallback-start-failed', { reason: fallbackError.message, code: fallbackError.code || null });
      if (fallback) await stopCandidate(fallback, time, log, 'fallback');
      return { status: 'rollback-failed', reason: fallbackError.message };
    }
  } finally {
    oldProcess?.close();
    if (config.updatingMarker) {
      try { fs.unlinkSync(config.updatingMarker); }
      catch (cause) { if (cause.code !== 'ENOENT') log('updating-marker-cleanup-failed', { reason: cause.message }); }
    }
    unlock();
  }
}

if (require.main === module) {
  const filename = process.argv[2];
  if (!filename || !path.isAbsolute(filename)) {
    process.stderr.write('restart-worker requires an absolute configuration JSON path\n');
    process.exitCode = 1;
  } else {
    Promise.resolve().then(() => JSON.parse(fs.readFileSync(filename, 'utf8')))
      .then(config => runSupervisor(config))
      .then(result => { process.exitCode = result.status === 'confirmed' || result.status === 'rolled-back' ? 0 : 1; })
      .catch(cause => { process.stderr.write(`${cause.stack || cause}\n`); process.exitCode = 1; });
  }
}

module.exports = { runSupervisor, validateConfig, cleanArgs, restoreSettings, watchProcess };
