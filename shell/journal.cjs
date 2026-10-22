'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const TOKEN = /^[a-f0-9]{48}$/;
const MAX_PENDING_AGE = 24 * 60 * 60 * 1000;
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function error(code, message) {
  return Object.assign(new Error(message), { code });
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (cause) { return cause.code === 'EPERM'; }
}

function atomicWrite(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, value);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, filename);
    // Windows does not permit opening directories for fsync. The file itself is flushed.
    if (process.platform !== 'win32') {
      const directory = fs.openSync(path.dirname(filename), 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
  }
}

function writeJson(filename, value) {
  atomicWrite(filename, `${JSON.stringify(value, null, 2)}\n`);
}

// A reclaim directory serializes stale-lock removal. A live owner's lock is never reclaimed.
function acquireLock(directory, { timeoutMs = 0, staleUnownedMs = 30000 } = {}) {
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  const owner = { pid: process.pid, nonce: crypto.randomBytes(16).toString('hex'), at: Date.now() };
  for (;;) {
    try {
      fs.mkdirSync(directory);
      writeJson(path.join(directory, 'owner.json'), owner);
      return () => {
        try {
          const found = JSON.parse(fs.readFileSync(path.join(directory, 'owner.json'), 'utf8'));
          if (found.nonce !== owner.nonce) return;
          fs.unlinkSync(path.join(directory, 'owner.json'));
          fs.rmdirSync(directory);
        } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
      };
    } catch (cause) {
      if (cause.code !== 'EEXIST') throw cause;
    }
    let previous;
    let stale = false;
    try {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw error('INVALID_LOCK', 'Lock path is not a directory');
      try { previous = JSON.parse(fs.readFileSync(path.join(directory, 'owner.json'), 'utf8')); }
      catch (cause) { if (cause.code !== 'ENOENT' && !(cause instanceof SyntaxError)) throw cause; }
      stale = previous ? !alive(previous.pid) : Date.now() - stat.mtimeMs > staleUnownedMs;
    } catch (cause) { if (cause.code === 'ENOENT') continue; throw cause; }
    if (stale) {
      const claim = path.join(directory, 'reclaim');
      try {
        fs.mkdirSync(claim);
        // No new owner can acquire this directory before this rename completes.
        const latest = (() => {
          try { return JSON.parse(fs.readFileSync(path.join(directory, 'owner.json'), 'utf8')); }
          catch { return null; }
        })();
        if (latest && alive(latest.pid)) {
          fs.rmdirSync(claim);
        } else {
          const retired = `${directory}.stale-${owner.nonce}`;
          fs.renameSync(directory, retired);
          // Preserve the retired lock as diagnostic evidence; it cannot block a new owner.
          continue;
        }
      } catch (cause) { if (cause.code !== 'EEXIST' && cause.code !== 'ENOENT') throw cause; }
    }
    if (Date.now() >= deadline) throw error('UPDATE_LOCKED', 'Another update operation holds the lock');
    pause(Math.min(20, Math.max(1, deadline - Date.now())));
  }
}

function descriptor(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['id', 'version', 'manifestHash'].includes(key))
    || typeof value.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,159}$/.test(value.id)
    || value.id === '.' || value.id === '..'
    || typeof value.version !== 'string' || !value.version || value.version.length > 128
    || typeof value.manifestHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.manifestHash)) {
    throw error('INVALID_DESCRIPTOR', 'Business descriptor must contain only id, version and manifestHash');
  }
  return { id: value.id, version: value.version, manifestHash: value.manifestHash };
}

function compareVersions(left, right) {
  const parse = value => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
    if (!match) throw error('INVALID_VERSION', `Invalid version: ${value}`);
    return { numbers: match.slice(1, 4).map(Number), pre: match[4]?.split('.') || [] };
  };
  const a = parse(left), b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] > b.numbers[index] ? 1 : -1;
  }
  if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1;
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index += 1) {
    const x = a.pre[index], y = b.pre[index];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) > Number(y) ? 1 : -1;
    if (xn !== yn) return xn ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

function createJournal({ root, builtin, store }) {
  if (!path.isAbsolute(root) || !builtin || !path.isAbsolute(builtin.root) || typeof builtin.version !== 'string') {
    throw error('INVALID_JOURNAL_CONFIG', 'Journal root and builtin root must be absolute');
  }
  if (!store || typeof store.verify !== 'function') throw error('INVALID_STORE', 'Store verification is required');
  const filename = path.join(root, 'journal.json');
  const lock = path.join(root, 'journal.lock');
  const healthPath = token => {
    if (!TOKEN.test(token || '')) throw error('INVALID_UPDATE_TOKEN', 'Invalid update token');
    return path.join(root, `health-${token}.json`);
  };
  const initial = () => ({ schema: 1, current: null, previous: null, pending: null, failures: [] });

  function read() {
    let state;
    try { state = JSON.parse(fs.readFileSync(filename, 'utf8')); }
    catch (cause) {
      if (cause.code === 'ENOENT') return initial();
      throw error('CORRUPT_JOURNAL', `Cannot read update journal: ${cause.message}`);
    }
    try {
      if (state.schema !== 1 || !Array.isArray(state.failures)) throw new Error('Unknown journal schema');
      if (state.current !== null) descriptor(state.current);
      if (state.previous !== null) descriptor(state.previous);
      if (state.pending !== null) {
        descriptor(state.pending.descriptor);
        if (!TOKEN.test(state.pending.token) || !['prepared', 'booting'].includes(state.pending.status)
          || !Number.isFinite(state.pending.preparedAt)) throw new Error('Invalid pending transaction');
      }
    } catch (cause) { throw error('CORRUPT_JOURNAL', `Invalid update journal: ${cause.message}`); }
    return state;
  }

  function mutate(fn, recoverCorruption = false) {
    const unlock = acquireLock(lock, { timeoutMs: 2000 });
    try {
      let state;
      try { state = read(); }
      catch (cause) {
        if (!recoverCorruption || cause.code !== 'CORRUPT_JOURNAL') throw cause;
        const backup = `${filename}.corrupt-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
        atomicWrite(backup, fs.readFileSync(filename));
        state = initial();
        fail(state, null, `journal-corrupt: ${cause.message}`);
        const fd = fs.openSync(path.join(root, 'update.log'), 'a', 0o600);
        try {
          fs.writeSync(fd, `${JSON.stringify({ at: new Date().toISOString(), event: 'journal-corrupt', backup, reason: cause.message })}\n`);
          fs.fsyncSync(fd);
        } finally { fs.closeSync(fd); }
      }
      return fn(state);
    } finally { unlock(); }
  }

  function fail(state, pending, reason) {
    state.failures.push({ token: pending?.token || null, descriptor: pending?.descriptor || null,
      reason: String(reason).slice(0, 2000), at: Date.now() });
    state.failures = state.failures.slice(-20);
  }

  function resolve(value) {
    if (value === null) return { root: builtin.root, version: builtin.version, descriptor: null, token: null };
    const clean = descriptor(value);
    const verified = store.verify(clean);
    if (!verified || !path.isAbsolute(verified.root) || verified.version !== clean.version) {
      throw error('INVALID_STORE_RESULT', 'Store returned an invalid verified version');
    }
    return { root: verified.root, version: clean.version, descriptor: clean, token: null };
  }

  function healthy(state) {
    try {
      const current = resolve(state.current);
      if (state.current && compareVersions(builtin.version, current.version) > 0) {
        state.previous = state.current;
        state.current = null;
        return resolve(null);
      }
      return current;
    }
    catch (cause) {
      fail(state, { descriptor: state.current }, `current-invalid: ${cause.message}`);
      try {
        const previous = resolve(state.previous);
        if (state.previous && compareVersions(builtin.version, previous.version) > 0) {
          state.current = null;
          return resolve(null);
        }
        state.current = state.previous;
        state.previous = null;
        return previous;
      } catch (previousError) {
        fail(state, { descriptor: state.previous }, `previous-invalid: ${previousError.message}`);
        state.current = null;
        state.previous = null;
        return resolve(null);
      }
    }
  }

  function prepare(value) {
    const clean = descriptor(value);
    resolve(clean);
    return mutate(state => {
      const pending = state.pending;
      if (pending && (pending.status === 'booting' && alive(pending.bootPid)
        || Date.now() - pending.preparedAt <= MAX_PENDING_AGE)) {
        throw error('UPDATE_IN_PROGRESS', 'An update transaction is already pending');
      }
      if (pending) fail(state, pending, 'expired-before-prepare');
      const token = crypto.randomBytes(24).toString('hex');
      state.pending = { token, descriptor: clean, status: 'prepared', preparedAt: Date.now(),
        bootStartedAt: null, bootPid: null };
      writeJson(filename, state);
      return token;
    }, true);
  }

  function select(token) {
    return mutate(state => {
      if (token !== undefined && token !== null) {
        const pending = state.pending;
        if (!TOKEN.test(token) || !pending || pending.token !== token) {
          throw error('INVALID_UPDATE_TOKEN', 'Update token does not match the pending transaction');
        }
        if (pending.status === 'booting') throw error('UPDATE_ALREADY_BOOTING', 'This update token has already been used');
        if (Date.now() - pending.preparedAt > MAX_PENDING_AGE) {
          fail(state, pending, 'expired-before-boot');
          state.pending = null;
          writeJson(filename, state);
          throw error('UPDATE_EXPIRED', 'The pending update expired');
        }
        let selected;
        try { selected = resolve(pending.descriptor); }
        catch (cause) {
          fail(state, pending, `candidate-invalid: ${cause.message}`);
          state.pending = null;
          writeJson(filename, state);
          throw cause;
        }
        pending.status = 'booting';
        pending.bootPid = process.pid;
        pending.bootStartedAt = Date.now();
        writeJson(filename, state);
        return { ...selected, token };
      }
      if (state.pending?.status === 'booting') {
        if (alive(state.pending.bootPid)) throw error('UPDATE_IN_PROGRESS', 'The candidate process is still running');
        fail(state, state.pending, 'interrupted-candidate-boot');
        state.pending = null;
      } else if (state.pending && Date.now() - state.pending.preparedAt > MAX_PENDING_AGE) {
        fail(state, state.pending, 'expired-before-boot');
        state.pending = null;
      }
      const selected = healthy(state);
      writeJson(filename, state);
      return selected;
    }, !token);
  }

  function ready(token, pid) {
    return mutate(state => {
      const pending = state.pending;
      if (!pending || pending.token !== token || pending.status !== 'booting' || pending.bootPid !== pid || !alive(pid)) {
        throw error('INVALID_HEALTH_SIGNAL', 'Health signal does not match the running candidate');
      }
      const value = { token, pid, at: Date.now(), manifestHash: pending.descriptor.manifestHash };
      writeJson(healthPath(token), value);
      return value;
    });
  }

  function confirm(token) {
    return mutate(state => {
      const pending = state.pending;
      if (!pending || pending.token !== token || pending.status !== 'booting' || !alive(pending.bootPid)) {
        throw error('INVALID_UPDATE_TOKEN', 'Cannot confirm a transaction without a running candidate');
      }
      const signal = readHealth(token);
      if (!signal || signal.pid !== pending.bootPid || signal.manifestHash !== pending.descriptor.manifestHash
        || signal.at < pending.bootStartedAt) throw error('INVALID_HEALTH_SIGNAL', 'Candidate health has not been reported');
      resolve(pending.descriptor);
      state.previous = state.current;
      state.current = pending.descriptor;
      state.pending = null;
      writeJson(filename, state);
      return state.current;
    });
  }

  function rollback(token, reason) {
    return mutate(state => {
      if (state.pending && state.pending.token !== token) throw error('INVALID_UPDATE_TOKEN', 'Cannot roll back a different transaction');
      if (state.pending) {
        fail(state, state.pending, reason || 'supervisor-rollback');
        state.pending = null;
      }
      const selected = healthy(state);
      writeJson(filename, state);
      return selected;
    });
  }

  function readHealth(token) {
    try {
      const signal = JSON.parse(fs.readFileSync(healthPath(token), 'utf8'));
      return signal.token === token && Number.isInteger(signal.pid) && Number.isFinite(signal.at) ? signal : null;
    } catch (cause) { if (cause.code === 'ENOENT' || cause instanceof SyntaxError) return null; throw cause; }
  }

  return { read, prepare, select, confirm, rollback, ready, readHealth };
}

module.exports = { createJournal, atomicWrite, writeJson, acquireLock, alive };
