'use strict';

// Run with Node on Windows. All application state, signed fixtures and evidence
// stay under artifacts/; the installed widget and its userData are never used.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {collectFiles} = require('../tools/build-payload.cjs');
const {createManifest, createPackage, canonicalManifest, sha256} = require('../shell/package.cjs');
const {createStore} = require('../shell/store.cjs');

const project = path.resolve(__dirname, '..');
const output = path.join(project, 'artifacts', 'business-update-e2e', `${Date.now()}-${process.pid}`);
const appRoot = path.join(output, 'app');
const profile = path.join(output, 'profile');
const updateRoot = path.join(profile, 'business-updates');
const reports = path.join(output, 'reports');
const checks = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let server;
let child;
let stdout;
let stderr;
let nextCommand = 0;

function readJson(filename) {
  try { return JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
}
function writeJson(filename, data) {
  const temporary = filename + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(data, null, 2));
  fs.renameSync(temporary, filename);
}
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}
function record(message) { checks.push(message); console.log('PASS', message); }
async function waitFor(label, operation, timeout = 90000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await operation();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`Timed out: ${label}. Evidence: ${output}`);
}
function snapshot(directory) {
  const files = {};
  function walk(folder) {
    for (const entry of fs.readdirSync(folder, {withFileTypes: true})) {
      const filename = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(filename);
      else {
        assert.ok(entry.isFile(), `Unexpected non-file: ${filename}`);
        files[path.relative(directory, filename).replaceAll('\\', '/')] = sha256(fs.readFileSync(filename));
      }
    }
  }
  walk(directory);
  return files;
}

// This driver is copied into the fixture shell. It only hides test windows and
// calls the real preload APIs; update code and health supervision run unchanged.
function electronDriver() {
  const fs = require('node:fs');
  const path = require('node:path');
  const {app, ipcMain} = require('electron');
  const output = process.env.BUSY_MAGPIE_E2E_ROOT;
  if (!output || !process.argv.includes('--preview')
    || path.resolve(process.env.BUSY_MAGPIE_PREVIEW_DIR || '') !== path.join(output, 'profile')
    || path.dirname(__dirname) !== path.join(output, 'app')) {
    throw new Error('The E2E driver requires its isolated preview fixture');
  }
  const reports = path.join(output, 'reports');
  const lifecycle = (event, details = {}) => fs.appendFileSync(path.join(output, 'lifecycle.ndjson'), JSON.stringify({pid: process.pid, event, at: Date.now(), ...details}) + '\n');
  const write = (name, data) => {
    const filename = path.join(reports, name + '.json');
    const temporary = filename + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(data, null, 2));
    fs.renameSync(temporary, filename);
  };
  fs.appendFileSync(path.join(output, 'starts.ndjson'), JSON.stringify({pid: process.pid, argv: process.argv, at: Date.now()}) + '\n');
  app.setPath('userData', path.join(output, 'profile'));
  app.setPath('sessionData', path.join(output, 'profile'));
  app.disableHardwareAcceleration();
  for (const name of ['before-quit', 'will-quit', 'quit']) app.on(name, () => lifecycle(name));
  app.on('child-process-gone', (_event, details) => lifecycle('child-process-gone', details));
  process.on('exit', code => lifecycle('process-exit', {code}));
  let window;
  let contents;
  let commandRunning = false;
  let handled = 0;
  const errors = [];
  app.on('browser-window-created', (_event, created) => {
    window = created;
    created.show = () => {};
    created.showInactive = () => {};
    created.focus = () => {};
    created.on('close', () => lifecycle('window-close'));
    created.on('closed', () => lifecycle('window-closed'));
    created.webContents.on('did-start-loading', () => lifecycle('did-start-loading'));
    created.webContents.on('did-finish-load', () => lifecycle('did-finish-load'));
    created.webContents.on('render-process-gone', (_event, details) => lifecycle('render-process-gone', details));
    created.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
    created.webContents.on('did-fail-load', (_event, code, description) => errors.push(`${code}: ${description}`));
  });
  ipcMain.once('busy:ready', async event => {
    contents = event.sender;
    try {
      const state = await contents.executeJavaScript(`window.busy.bootstrap().then(data=>({version:data.version,shellVersion:data.update.shellVersion,opacity:data.settings.opacity,versionText:document.getElementById('appVersionText').textContent,guide:!!document.getElementById('firstRunMask'),url:location.href}))`);
      write('ready-' + process.pid, {pid: process.pid, state, errors});
    } catch (error) { write('driver-error-' + process.pid, {error: error.stack}); }
  });
  const timer = setInterval(async () => {
    if (commandRunning || !contents || contents.isDestroyed()) return;
    let command;
    try { command = JSON.parse(fs.readFileSync(path.join(output, 'command.json'), 'utf8')); }
    catch { return; }
    if (command.pid !== process.pid || command.id <= handled) return;
    commandRunning = true;
    handled = command.id;
    try {
      if (command.action === 'install') {
        write('command-' + command.id, {accepted: true, pid: process.pid});
        await contents.executeJavaScript('window.busy.updatesInstall()');
      } else if (command.action === 'check') {
        const state = await contents.executeJavaScript('window.busy.updatesCheck()');
        write('command-' + command.id, {state, pid: process.pid});
      } else if (command.action === 'save') {
        const opacity = JSON.stringify(command.opacity);
        const result = await contents.executeJavaScript(`window.busy.settingsGet().then(current=>window.busy.settingsSave({...current.settings,opacity:${opacity}}))`);
        write('command-' + command.id, {result, pid: process.pid});
      } else if (command.action === 'inspect') {
        const state = await contents.executeJavaScript(`window.busy.bootstrap().then(data=>({version:data.version,shellVersion:data.update.shellVersion,opacity:data.settings.opacity,versionText:document.getElementById('appVersionText').textContent,guide:!!document.getElementById('firstRunMask'),url:location.href}))`);
        write('command-' + command.id, {state, pid: process.pid, errors});
      } else if (command.action === 'exit') {
        write('command-' + command.id, {exiting: true, pid: process.pid});
        clearInterval(timer);
        app.quit();
      }
    } catch (error) { write('command-' + command.id, {error: error.stack, pid: process.pid}); }
    finally { commandRunning = false; }
  }, 50);
  setTimeout(() => { write('watchdog-' + process.pid, {error: 'Fixture lifetime exceeded'}); window?.destroy(); app.exit(12); }, 180000).unref();
  require('./bootstrap.cjs');
}

async function command(pid, action, extra = {}) {
  const id = ++nextCommand;
  writeJson(path.join(output, 'command.json'), {id, pid, action, ...extra});
  const response = await waitFor(`renderer command ${action}`, () => readJson(path.join(reports, `command-${id}.json`)), 30000);
  assert.equal(response.error, undefined, response.error);
  return response;
}
async function ready(version, exclude = []) {
  return waitFor(`renderer ${version} is ready`, () => {
    const failedFallback = events().find(entry => entry.event === 'fallback-start-failed');
    if (failedFallback) throw new Error(`Fallback failed: ${failedFallback.reason}. Evidence: ${output}`);
    const failedVersion = journal()?.failures.find(entry => entry.descriptor?.version === version);
    if (failedVersion) throw new Error(`Update ${version} failed: ${failedVersion.reason}. Evidence: ${output}`);
    for (const filename of fs.readdirSync(reports)) {
      if (/^driver-error-\d+\.json$/.test(filename)) throw new Error(readJson(path.join(reports, filename)).error);
      if (!/^ready-\d+\.json$/.test(filename)) continue;
      const report = readJson(path.join(reports, filename));
      if (report?.state.version === version && !exclude.includes(report.pid)) return report;
    }
    return false;
  });
}
function journal() { return readJson(path.join(updateRoot, 'journal.json')); }
function events() {
  const filename = path.join(updateRoot, 'update.log');
  if (!fs.existsSync(filename)) return [];
  return fs.readFileSync(filename, 'utf8').split(/\r?\n/).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}
async function settled(token, event) {
  await waitFor(`${event} and supervisor exit`, () => {
    const match = events().find(entry => entry.token === token && entry.event === event);
    return match && !fs.existsSync(path.join(updateRoot, 'supervisor.lock')) && !alive(match.supervisorPid);
  });
}

async function run() {
  assert.equal(process.platform, 'win32', 'Business update installation currently requires Windows');
  fs.mkdirSync(reports, {recursive: true});
  fs.mkdirSync(profile, {recursive: true});
  fs.mkdirSync(appRoot, {recursive: true});
  for (const folder of ['src', 'web', 'assets', 'shell']) fs.cpSync(path.join(project, folder), path.join(appRoot, folder), {recursive: true});
  const pkg = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8'));
  fs.writeFileSync(path.join(appRoot, 'package.json'), JSON.stringify({...pkg, version: '1.4.0', main: 'shell/e2e-driver.cjs'}, null, 2));
  fs.writeFileSync(path.join(appRoot, 'shell', 'e2e-driver.cjs'), '(' + electronDriver.toString() + ')();\n');
  const pair = crypto.generateKeyPairSync('ed25519');
  const trustedKeys = {'isolated-e2e': pair.publicKey.export({type: 'spki', format: 'pem'})};
  fs.writeFileSync(path.join(appRoot, 'shell', 'trusted-keys.json'), JSON.stringify(trustedKeys));
  const files = collectFiles(appRoot);
  function payload(version, failed) {
    const payloadFiles = new Map(files);
    if (failed) payloadFiles.set('src/main.js', Buffer.from(`'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {app} = require('electron');
const filename = path.join(app.getPath('userData'), 'settings.json');
const settings = JSON.parse(fs.readFileSync(filename, 'utf8'));
fs.writeFileSync(filename, JSON.stringify({...settings, opacity:0.91, failedMigration:'isolated-e2e'}));
throw new Error('isolated-e2e candidate failed before renderer startup');
`));
    const manifest = createManifest({version, keyId: 'isolated-e2e', files: payloadFiles});
    const bytes = createPackage({manifest, files: payloadFiles, privateKey: pair.privateKey});
    const manifestHash = sha256(canonicalManifest(manifest));
    fs.writeFileSync(path.join(output, `${version}.bmpkg`), bytes);
    return {bytes, descriptor: {id: `${version}-${manifestHash.slice(0, 16)}`, version, manifestHash},
      feed: {format: 1, version, minShellVersion: '1.4.0', shellApi: 1, size: bytes.length, sha256: sha256(bytes), packageUrl: `/${version}.bmpkg`}};
  }
  const success = payload('1.4.1', false);
  const failure = payload('1.4.2', true);
  let feed = success.feed;
  const packages = new Map([['/1.4.1.bmpkg', success.bytes], ['/1.4.2.bmpkg', failure.bytes]]);
  server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/business-latest.json') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(feed));
    } else if (packages.has(url.pathname)) {
      const bytes = packages.get(url.pathname);
      response.setHeader('Content-Type', 'application/octet-stream');
      response.setHeader('Content-Length', bytes.length);
      response.end(bytes);
    } else {
      const usage = url.pathname.includes('/usage');
      const data = usage ? {period: url.searchParams.get('period') || '30d', calls: 0, input: 0, output: 0}
        : {pid: 123, seq: 1, totals: {requests: 0, rerouted: 0, errors: 0}, routes: []};
      setTimeout(() => { if (!response.destroyed) { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(data)); } }, 100);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  writeJson(path.join(profile, 'settings.json'), {gateway: origin, topmost: false, autostart: false, keepAlive: false, updateMode: 'never', left: 120, top: 120});
  const electron = require('electron');
  const executableHash = sha256(fs.readFileSync(electron));
  const builtinFiles = snapshot(appRoot);
  const env = {...process.env, BUSY_MAGPIE_E2E_ROOT: output, BUSY_MAGPIE_PREVIEW_DIR: profile, BUSY_MAGPIE_DEV_UPDATE_FEED: origin + '/business-latest.json'};
  delete env.ELECTRON_RUN_AS_NODE;
  stdout = fs.openSync(path.join(output, 'electron.stdout.log'), 'a');
  stderr = fs.openSync(path.join(output, 'electron.stderr.log'), 'a');
  child = spawn(electron, [appRoot, '--preview'], {cwd: appRoot, env, windowsHide: true, stdio: ['ignore', stdout, stderr]});
  child.on('error', error => writeJson(path.join(reports, 'spawn-error.json'), {error: error.stack}));
  child.on('exit', (code, signal) => fs.appendFileSync(path.join(output, 'lifecycle.ndjson'), JSON.stringify({pid: child.pid, event: 'initial-child-exit', at: Date.now(), code, signal}) + '\n'));
  const original = await ready('1.4.0');
  assert.equal(original.pid, child.pid);
  assert.equal(original.state.opacity, 0.3);
  assert.equal(original.state.guide, false);
  assert.match(original.state.versionText, /v1\.4\.0/);
  assert.deepEqual(original.errors, []);
  record('real builtin renderer starts at v1.4.0 with 30% opacity and no guide');
  const saved = await command(original.pid, 'save', {opacity: 0.42});
  assert.equal(saved.result.ok, true);
  assert.equal(readJson(path.join(profile, 'settings.json')).opacity, 0.42);
  const checked = await command(original.pid, 'check');
  assert.equal(checked.state.latest, '1.4.1');
  assert.equal(checked.state.kind, 'business');
  assert.equal(checked.state.available, true);
  await command(original.pid, 'install');
  const upgraded = await ready('1.4.1');
  await waitFor('healthy candidate committed', () => journal()?.current?.version === '1.4.1' && journal().pending === null);
  const firstToken = events().find(entry => entry.event === 'candidate-started' && entry.pid === upgraded.pid)?.token;
  assert.ok(firstToken);
  await settled(firstToken, 'candidate-confirmed');
  assert.notEqual(child.exitCode, null, 'the original ChildProcess must have emitted its exit event');
  assert.equal(alive(original.pid), false);
  assert.equal(alive(upgraded.pid), true);
  assert.notEqual(upgraded.pid, original.pid);
  assert.deepEqual(journal().current, success.descriptor);
  assert.equal(journal().previous, null);
  assert.deepEqual(journal().failures, []);
  assert.equal(upgraded.state.shellVersion, '1.4.0');
  assert.equal(upgraded.state.opacity, 0.42);
  assert.match(upgraded.state.versionText, /v1\.4\.1/);
  assert.ok(upgraded.state.url.includes(success.descriptor.id));
  assert.deepEqual(upgraded.errors, []);
  const store = createStore({root: updateRoot, trustedKeys, shellVersion: '1.4.0', shellApi: 1});
  const healthyRoot = store.verify(journal().current).root;
  const healthyFiles = snapshot(healthyRoot);
  const baselineSettings = fs.readFileSync(path.join(profile, 'settings.json'));
  writeJson(path.join(output, 'confirmed-state.json'), journal());
  record('signed v1.4.1 downloads, old process exits, real renderer reports health, and supervisor commits it');

  feed = failure.feed;
  const failedCheck = await command(upgraded.pid, 'check');
  assert.equal(failedCheck.state.latest, '1.4.2');
  await command(upgraded.pid, 'install');
  const restored = await ready('1.4.1', [upgraded.pid]);
  const failedState = await waitFor('failed candidate rolled back', () => {
    const state = journal();
    return state?.pending === null && state.failures.some(entry => entry.descriptor?.version === '1.4.2') && state;
  });
  const failedRecord = failedState.failures.find(entry => entry.descriptor?.version === '1.4.2');
  await settled(failedRecord.token, 'fallback-started');
  assert.match(failedRecord.reason, /candidate-exited/);
  assert.deepEqual(failedState.current, success.descriptor);
  assert.equal(failedState.previous, null);
  assert.deepEqual(failedRecord.descriptor, failure.descriptor);
  const candidate = events().find(entry => entry.token === failedRecord.token && entry.event === 'candidate-started');
  assert.ok(candidate && candidate.pid !== upgraded.pid && candidate.pid !== restored.pid);
  assert.equal(alive(candidate.pid), false);
  assert.equal(alive(upgraded.pid), false);
  assert.equal(alive(restored.pid), true);
  const restoredState = await command(restored.pid, 'inspect');
  assert.equal(restoredState.state.opacity, 0.42);
  assert.equal(restoredState.state.version, '1.4.1');
  assert.equal(restoredState.state.shellVersion, '1.4.0');
  assert.match(restoredState.state.versionText, /v1\.4\.1/);
  assert.deepEqual(restoredState.errors, []);
  const transaction = path.join(updateRoot, 'transactions', failedRecord.token);
  assert.deepEqual(fs.readFileSync(path.join(transaction, 'settings.json')), baselineSettings);
  const badSettings = readJson(path.join(transaction, 'failed-settings.json'));
  assert.equal(badSettings.opacity, 0.91);
  assert.equal(badSettings.failedMigration, 'isolated-e2e');
  assert.deepEqual(fs.readFileSync(path.join(profile, 'settings.json')), baselineSettings);
  assert.ok(events().some(entry => entry.token === failedRecord.token && entry.event === 'settings-restored'));
  record('v1.4.2 main-process failure restores v1.4.1 in a new process and rolls settings back byte-for-byte');
  assert.deepEqual(snapshot(healthyRoot), healthyFiles);
  assert.deepEqual(snapshot(appRoot), builtinFiles);
  assert.equal(sha256(fs.readFileSync(electron)), executableHash);
  assert.deepEqual(store.verify(success.descriptor).manifest.version, '1.4.1');
  assert.deepEqual(store.verify(failure.descriptor).manifest.version, '1.4.2');
  assert.equal(fs.existsSync(path.join(profile, 'updating')), false);
  record('version directories, installed fixture files and Electron executable remain unchanged');
  writeJson(path.join(output, 'result.json'), {ok: true, checks, original, upgraded, restored, failedState,
    executableHash, healthyFiles, builtinFiles});
  await command(restored.pid, 'exit');
  await waitFor('fixture process exits after verification', () => !alive(restored.pid), 15000);
  console.log('Evidence:', output);
}

run().catch(error => {
  fs.mkdirSync(output, {recursive: true});
  writeJson(path.join(output, 'result.json'), {ok: false, checks, error: error.stack, journal: journal(), events: events()});
  console.error(error.stack);
  process.exitCode = 1;
}).finally(async () => {
  // Only PIDs written by this isolated fixture and its supervisor are eligible.
  const starts = path.join(output, 'starts.ndjson');
  const owned = new Set(fs.existsSync(starts) ? fs.readFileSync(starts, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line).pid) : []);
  if (child?.pid) owned.add(child.pid);
  for (const event of events()) if (event.supervisorPid) owned.add(event.supervisorPid);
  const lifecyclePath = path.join(output, 'lifecycle.ndjson');
  const quitting = new Set(fs.existsSync(lifecyclePath) ? fs.readFileSync(lifecyclePath, 'utf8').trim().split(/\r?\n/).filter(Boolean)
    .map(line => JSON.parse(line)).filter(event => event.event === 'before-quit').map(event => event.pid) : []);
  for (const pid of owned) if (alive(pid) && !quitting.has(pid)) { try { process.kill(pid); } catch {} }
  // Preserve a process already in app.quit for exit-boundary diagnosis instead
  // of turning its natural shutdown into a test-generated termination.
  child?.unref();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  if (stdout !== undefined) fs.closeSync(stdout);
  if (stderr !== undefined) fs.closeSync(stderr);
});
