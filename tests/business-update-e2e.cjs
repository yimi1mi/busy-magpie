'use strict';

// Run with Node on Windows. All application state, signed fixtures and evidence
// stay under artifacts/; the installed widget and its userData are never used.
// Optional: --packaged <absolute win-unpacked directory> copies and exercises
// that complete runtime with app.isPackaged=true instead of a development app.
// --original-immutable <directory> leaves the build untouched and uses local
// debugger ports plus the existing artifacts/signing/business-ed25519.pem key.
// That mode requires an explicitly authorized local key; it never publishes.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {spawn, spawnSync} = require('node:child_process');
const {collectFiles} = require('../tools/build-payload.cjs');
const {createManifest, createPackage, canonicalManifest, sha256} = require('../shell/package.cjs');
const {createStore} = require('../shell/store.cjs');

const project = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const packagedSource = args[0] === '--packaged' ? args[1] : null;
const originalSource = args[0] === '--original-immutable' ? args[1] : null;
const originalImmutable = Boolean(originalSource);
const packaged = Boolean(packagedSource || originalSource);
const output = path.join(project, 'artifacts', 'business-update-e2e', `${Date.now()}-${process.pid}`);
const runtimeRoot = originalImmutable ? path.resolve(originalSource) : path.join(output, 'runtime');
const appRoot = packaged ? path.join(runtimeRoot, 'resources', 'app') : path.join(output, 'app');
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
let externalController;

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
  fs.writeFileSync(process.env.BUSY_MAGPIE_E2E_ROOT + `/driver-evaluated-${process.pid}.txt`, 'JavaScript entry evaluated');
  const path = require('node:path');
  const {app, ipcMain} = require('electron');
  const output = process.env.BUSY_MAGPIE_E2E_ROOT;
  const packaged = process.env.BUSY_MAGPIE_E2E_PACKAGED === '1';
  const appRoot = packaged ? path.join(output, 'runtime', 'resources', 'app') : path.join(output, 'app');
  const entry = {pid: process.pid, argv: process.argv, directory: __dirname, expectedAppRoot: appRoot,
    appPath: app.getAppPath(), isPackaged: app.isPackaged, packaged, previewDirectory: process.env.BUSY_MAGPIE_PREVIEW_DIR};
  fs.writeFileSync(path.join(output, `driver-entry-${process.pid}.json`), JSON.stringify(entry, null, 2));
  if (!output || !process.argv.includes('--preview')
    || path.resolve(process.env.BUSY_MAGPIE_PREVIEW_DIR || '') !== path.join(output, 'profile')
    || path.dirname(__dirname) !== appRoot || app.isPackaged !== packaged) {
    fs.writeFileSync(path.join(output, 'reports', `driver-error-${process.pid}.json`), JSON.stringify({error: 'The E2E driver requires its isolated preview fixture', entry}));
    app.exit(13);
    return;
  }
  const reports = path.join(output, 'reports');
  const lifecycle = (event, details = {}) => fs.appendFileSync(path.join(output, 'lifecycle.ndjson'), JSON.stringify({pid: process.pid, event, at: Date.now(), ...details}) + '\n');
  const runtime = () => {
    const value = {isPackaged: app.isPackaged, appPath: app.getAppPath(), executable: process.execPath};
    if (packaged) {
      const prefix = path.join(appRoot, 'node_modules') + path.sep;
      value.dependencies = Object.fromEntries(['koffi', 'electron-updater'].map(name => [name, require.resolve(name)]));
      value.loadedDependencies = Object.keys(require.cache).filter(filename => path.isAbsolute(filename)
        && filename.split(path.sep).includes('node_modules'));
      for (const filename of [...Object.values(value.dependencies), ...value.loadedDependencies]) {
        if (!filename.toLowerCase().startsWith(prefix.toLowerCase())) throw new Error('Packaged fixture loaded a dependency outside its own node_modules: ' + filename);
      }
    }
    return value;
  };
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
      write('ready-' + process.pid, {pid: process.pid, state, errors, runtime: runtime()});
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
        write('command-' + command.id, {state, pid: process.pid, errors, runtime: runtime()});
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
  if (externalController) return externalController.command(pid, action, extra);
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
    if (externalController) return externalController.ready(version, exclude);
    for (const filename of fs.readdirSync(reports)) {
      if (/^driver-error-\d+\.json$/.test(filename)) throw new Error(readJson(path.join(reports, filename)).error);
      if (!/^ready-\d+\.json$/.test(filename)) continue;
      const report = readJson(path.join(reports, filename));
      if (report?.state.version === version && !exclude.includes(report.pid)) return report;
    }
    if (version === '1.4.0' && child?.exitCode !== null) {
      throw new Error(`Initial application exited before renderer startup with code ${child.exitCode}. Evidence: ${output}`);
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
function lifecycleEvents() {
  const filename = path.join(output, 'lifecycle.ndjson');
  if (!fs.existsSync(filename)) return [];
  return fs.readFileSync(filename, 'utf8').split(/\r?\n/).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}
function nativeExitObserved(pid) {
  return events().some(event => (event.event === 'old-process-exited' && event.oldPid === pid)
    || (['candidate-exit', 'fallback-exit'].includes(event.event) && event.pid === pid))
    || lifecycleEvents().some(event => event.pid === pid && event.event === 'initial-child-exit');
}
function stoppedBusiness(pid, token, since) {
  const marker = readJson(path.join(updateRoot, `shutdown-${token}-${pid}.json`));
  if (marker) {
    assert.deepEqual(Object.keys(marker).sort(), ['at', 'phase', 'pid', 'token']);
    assert.equal(marker.token, token);
    assert.equal(marker.pid, pid);
    assert.equal(marker.phase, 'quiescent');
    assert.ok(Number.isFinite(marker.at) && marker.at >= since && marker.at <= Date.now(), JSON.stringify(marker));
    const lifecycle = lifecycleEvents().filter(event => event.pid === pid && event.at >= since && event.at <= marker.at);
    assert.ok(lifecycle.some(event => event.event === 'process-exit'), 'Node exit must precede the quiescent marker');
    assert.ok(lifecycle.some(event => event.event === 'quit'), 'Electron quit must precede the quiescent marker');
  }
  const nativeExited = nativeExitObserved(pid);
  assert.ok(marker || nativeExited, `PID ${pid} must have a matching quiescent marker or an observed physical exit`);
  return {pid, token, marker, nativeExitObserved: nativeExited, observedAt: Date.now()};
}
async function settled(token, event) {
  await waitFor(`${event} and supervisor exit`, () => {
    const match = events().find(entry => entry.token === token && entry.event === event);
    return match && !fs.existsSync(path.join(updateRoot, 'supervisor.lock')) && !alive(match.supervisorPid);
  });
}

async function inspectorTarget(port, type) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, {signal: AbortSignal.timeout(1000)});
    const entries = await response.json();
    return entries.find(entry => entry.type === type && (type !== 'page' || entry.url.endsWith('/web/index.html')))?.webSocketDebuggerUrl || null;
  } catch { return null; }
}
function listeningPorts(pid) {
  const result = spawnSync('netstat.exe', ['-ano', '-p', 'tcp'], {windowsHide: true, encoding: 'utf8', timeout: 5000});
  if (result.error) throw result.error;
  return result.stdout.split(/\r?\n/).flatMap(line => {
    const parts = line.trim().split(/\s+/);
    if (parts[0] !== 'TCP' || parts[3] !== 'LISTENING' || Number(parts[4]) !== pid || !parts[1].startsWith('127.0.0.1:')) return [];
    return [Number(parts[1].slice('127.0.0.1:'.length))];
  });
}
async function inspectorConnection(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  const listeners = [];
  let sequence = 0;
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, {once: true});
    socket.addEventListener('error', () => reject(new Error('Inspector connection failed')), {once: true});
  });
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (!message.id) { for (const listener of listeners) listener(message); return; }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timeout);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  socket.addEventListener('close', () => {
    for (const request of pending.values()) { clearTimeout(request.timeout); request.reject(new Error('Inspector closed')); }
    pending.clear();
  });
  function call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timeout = setTimeout(() => { pending.delete(id); reject(new Error('Inspector request timed out: ' + method)); }, 10000);
      pending.set(id, {resolve, reject, timeout});
      socket.send(JSON.stringify({id, method, params}));
    });
  }
  return {
    call,
    onEvent: listener => listeners.push(listener),
    async evaluate(expression, awaitPromise = true) {
      const result = await call('Runtime.evaluate', {expression, awaitPromise, returnByValue: true});
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    },
    async close() {
      if (socket.readyState === WebSocket.CLOSED) return;
      const closed = new Promise(resolve => socket.addEventListener('close', resolve, {once: true}));
      socket.close();
      await closed;
    },
  };
}
function createExternalController() {
  let current;
  let lastMainUrl;
  let renderer;
  const errors = [];
  let mainPort;
  const stateExpression = `window.busy?.bootstrap().then(data=>({version:data.version,shellVersion:data.update.shellVersion,opacity:data.settings.opacity,versionText:document.getElementById('appVersionText')?.textContent,guide:!!document.getElementById('firstRunMask'),url:location.href,complete:document.readyState==='complete'}))`;
  async function mainSnapshot(url) {
    const connection = await inspectorConnection(url);
    try {
      return await connection.evaluate(`(() => {
        const r=process.mainModule.require.bind(process.mainModule),fs=r('node:fs'),path=r('node:path'),electron=r('electron'),app=electron.app;
        if(!globalThis.__busyShell) return null;
        if(path.resolve(app.getPath('userData'))!==${JSON.stringify(profile)}) throw new Error('Refusing to control a different profile');
        const output=${JSON.stringify(output)};
        if(!globalThis.__busyE2EObserver){
          globalThis.__busyE2EObserver=true;
          const log=(event,details={})=>fs.appendFileSync(path.join(output,'lifecycle.ndjson'),JSON.stringify({pid:process.pid,event,at:Date.now(),...details})+'\\n');
          for(const name of ['before-quit','will-quit','quit']) app.prependListener(name,()=>log(name));
          process.prependListener('exit',code=>log('process-exit',{code}));
          const watch=w=>{w.on('close',()=>log('window-close'));w.on('closed',()=>log('window-closed'));w.on('show',()=>w.hide());w.hide();};
          app.on('browser-window-created',(_e,w)=>watch(w));electron.BrowserWindow.getAllWindows().forEach(watch);
          fs.appendFileSync(path.join(output,'starts.ndjson'),JSON.stringify({pid:process.pid,argv:process.argv,at:Date.now()})+'\\n');
        }
        const resolve=r('node:module').createRequire(path.join(app.getAppPath(),'package.json')).resolve;
        return {pid:process.pid,isPackaged:app.isPackaged,appPath:app.getAppPath(),executable:process.execPath,
          dependencies:Object.fromEntries(['koffi','electron-updater'].map(name=>[name,resolve(name)])),
          loadedDependencies:Object.keys(process.mainModule.constructor._cache).filter(name=>path.isAbsolute(name)&&name.split(path.sep).includes('node_modules'))};
      })()`);
    } finally { await connection.close(); }
  }
  function validateRuntime(runtime) {
    assert.equal(runtime.isPackaged, true);
    assert.equal(runtime.appPath, appRoot);
    assert.equal(runtime.executable, path.join(runtimeRoot, 'Busy Magpie.exe'));
    const prefix = (path.join(appRoot, 'node_modules') + path.sep).toLowerCase();
    for (const filename of [...Object.values(runtime.dependencies), ...runtime.loadedDependencies]) {
      assert.ok(filename.toLowerCase().startsWith(prefix), 'Runtime dependency escaped the original package: ' + filename);
    }
  }
  return {
    async ready(version, exclude) {
      const application = readJson(path.join(updateRoot, 'runtime-ready.json'));
      if (!application || application.version !== version || exclude.includes(application.pid)) return false;
      const ports = listeningPorts(application.pid);
      let mainUrl;
      for (const port of ports) {
        const target = await inspectorTarget(port, 'node');
        if (target) { mainPort = port; mainUrl = target; break; }
      }
      if (!mainUrl || (mainUrl === lastMainUrl && exclude.includes(current?.pid))) return false;
      if (!current || mainUrl !== lastMainUrl) {
        const runtime = await mainSnapshot(mainUrl);
        if (!runtime) return false;
        assert.equal(runtime.pid, application.pid);
        validateRuntime(runtime);
        await renderer?.close();
        renderer = null;
        current = {pid: runtime.pid, runtime};
        lastMainUrl = mainUrl;
        errors.length = 0;
      }
      if (exclude.includes(current.pid)) return false;
      if (!renderer) {
        let active;
        try { active = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/); }
        catch (error) { if (error.code === 'ENOENT') return false; throw error; }
        const browserPort = Number(active[0]);
        if (!ports.includes(browserPort)) return false;
        const browser = await inspectorConnection(`ws://127.0.0.1:${browserPort}${active[1]}`);
        try {
          const processes = await browser.call('SystemInfo.getProcessInfo');
          assert.equal(processes.processInfo.find(info => info.type === 'browser')?.id, application.pid);
        } finally { await browser.close(); }
        const rendererUrl = await inspectorTarget(browserPort, 'page');
        if (!rendererUrl) return false;
        renderer = await inspectorConnection(rendererUrl);
        renderer.onEvent(message => {
          if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
          if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') errors.push(message.params.args.map(value => value.value ?? value.description).join(' '));
        });
        await renderer.call('Runtime.enable');
      }
      const state = await renderer.evaluate(stateExpression);
      if (!state || !state.complete || state.version !== version || !state.versionText?.includes('v' + version)) return false;
      const report = {...current, state, errors: [...errors]};
      writeJson(path.join(reports, `ready-${current.pid}.json`), report);
      return report;
    },
    async command(pid, action, extra) {
      assert.equal(current?.pid, pid);
      if (action === 'check') return {pid, state: await renderer.evaluate('window.busy.updatesCheck()')};
      if (action === 'save') return {pid, result: await renderer.evaluate(`window.busy.settingsGet().then(current=>window.busy.settingsSave({...current.settings,opacity:${JSON.stringify(extra.opacity)}}))`)};
      if (action === 'inspect') return {pid, state: await renderer.evaluate(stateExpression), runtime: current.runtime, errors: [...errors]};
      if (action === 'install') {
        await renderer.evaluate('window.busy.updatesInstall(); "accepted"', false);
        await renderer.close();
        renderer = null;
        return {pid, accepted: true};
      }
      if (action === 'exit') {
        await renderer?.close();
        renderer = null;
        const url = await inspectorTarget(mainPort, 'node');
        assert.equal(url, lastMainUrl);
        const main = await inspectorConnection(url);
        try {
          await main.evaluate(`(() => {if(process.pid!==${pid})throw new Error('Wrong test process');setTimeout(()=>process.mainModule.require('electron').app.quit(),500);return 'queued';})()`);
        } finally { await main.close(); }
        return {pid, exiting: true};
      }
      throw new Error('Unknown external action: ' + action);
    },
    async close() { await renderer?.close(); },
  };
}

async function run() {
  assert.equal(process.platform, 'win32', 'Business update installation currently requires Windows');
  assert.ok(args.length === 0 || (args.length === 2 && ['--packaged', '--original-immutable'].includes(args[0]) && path.isAbsolute(args[1])),
    'Usage: node tests/business-update-e2e.cjs [--packaged|--original-immutable <absolute win-unpacked directory>]');
  fs.mkdirSync(reports, {recursive: true});
  fs.mkdirSync(profile, {recursive: true});
  if (packaged) {
    const source = packagedSource || originalSource;
    assert.ok(fs.statSync(source).isDirectory(), 'The packaged source must be a directory');
    assert.ok(fs.statSync(path.join(source, 'Busy Magpie.exe')).isFile(), 'The packaged source must contain Busy Magpie.exe');
    assert.ok(fs.statSync(path.join(source, 'resources', 'app', 'package.json')).isFile(), 'The packaged source must contain resources/app/package.json');
    if (!originalImmutable) fs.cpSync(source, runtimeRoot, {recursive: true});
  } else {
    fs.mkdirSync(appRoot, {recursive: true});
    for (const folder of ['src', 'web', 'assets', 'shell']) fs.cpSync(path.join(project, folder), path.join(appRoot, folder), {recursive: true});
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(packaged ? appRoot : project, 'package.json'), 'utf8'));
  let keyId;
  let privateKey;
  let trustedKeys;
  if (originalImmutable) {
    assert.equal(pkg.version, '1.4.0');
    assert.equal(pkg.main, 'shell/bootstrap.cjs');
    keyId = 'busy-magpie-2026';
    privateKey = crypto.createPrivateKey(fs.readFileSync(path.join(project, 'artifacts/signing/business-ed25519.pem')));
    trustedKeys = JSON.parse(fs.readFileSync(path.join(appRoot, 'shell/trusted-keys.json'), 'utf8'));
    assert.equal(crypto.createPublicKey(privateKey).export({type: 'spki', format: 'pem'}), trustedKeys[keyId], 'The local signing key must match the untouched packaged public key');
  } else {
    fs.writeFileSync(path.join(appRoot, 'package.json'), JSON.stringify({...pkg, version: '1.4.0', main: 'shell/e2e-driver.cjs'}, null, 2));
    fs.writeFileSync(path.join(appRoot, 'shell', 'e2e-driver.cjs'), '(' + electronDriver.toString() + ')();\n');
    const pair = crypto.generateKeyPairSync('ed25519');
    keyId = 'isolated-e2e';
    privateKey = pair.privateKey;
    trustedKeys = {[keyId]: pair.publicKey.export({type: 'spki', format: 'pem'})};
    fs.writeFileSync(path.join(appRoot, 'shell', 'trusted-keys.json'), JSON.stringify(trustedKeys));
  }
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
    const manifest = createManifest({version, keyId, files: payloadFiles});
    const bytes = createPackage({manifest, files: payloadFiles, privateKey});
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
  const electron = packaged ? path.join(runtimeRoot, 'Busy Magpie.exe') : require('electron');
  const executableHash = sha256(fs.readFileSync(electron));
  const builtinFiles = snapshot(appRoot);
  const originalFiles = originalImmutable ? snapshot(runtimeRoot) : null;
  const env = {...process.env, BUSY_MAGPIE_E2E_ROOT: output, BUSY_MAGPIE_E2E_PACKAGED: packaged ? '1' : '0',
    BUSY_MAGPIE_PREVIEW_DIR: profile, BUSY_MAGPIE_DEV_UPDATE_FEED: origin + '/business-latest.json'};
  delete env.ELECTRON_RUN_AS_NODE;
  stdout = fs.openSync(path.join(output, 'electron.stdout.log'), 'a');
  stderr = fs.openSync(path.join(output, 'electron.stderr.log'), 'a');
  const launchArgs = packaged ? ['--preview'] : [appRoot, '--preview'];
  if (originalImmutable) {
    externalController = createExternalController();
    launchArgs.push('--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--inspect=127.0.0.1:0', `--user-data-dir=${profile}`);
  }
  child = spawn(electron, launchArgs, {cwd: packaged ? runtimeRoot : appRoot, env, windowsHide: !originalImmutable, stdio: ['ignore', stdout, stderr]});
  child.on('error', error => writeJson(path.join(reports, 'spawn-error.json'), {error: error.stack}));
  child.on('exit', (code, signal) => fs.appendFileSync(path.join(output, 'lifecycle.ndjson'), JSON.stringify({pid: child.pid, event: 'initial-child-exit', at: Date.now(), code, signal}) + '\n'));
  const original = await ready('1.4.0');
  assert.equal(original.pid, child.pid);
  assert.equal(original.runtime.isPackaged, packaged);
  assert.equal(original.runtime.appPath, appRoot);
  assert.equal(original.runtime.executable, electron);
  assert.equal(original.state.opacity, 0.3);
  assert.equal(original.state.guide, false);
  assert.match(original.state.versionText, /v1\.4\.0/);
  assert.deepEqual(original.errors, []);
  record('real builtin renderer starts at v1.4.0 with 30% opacity and no guide');
  if (packaged) record('packaged runtime starts without an app-directory argument and resolves runtime dependencies inside its own app');
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
  const firstHandoff = readJson(path.join(updateRoot, `handoff-${firstToken}.json`));
  const shutdownObservations = [stoppedBusiness(original.pid, firstToken, firstHandoff.at)];
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
  assert.equal(upgraded.runtime.isPackaged, packaged);
  assert.equal(upgraded.runtime.appPath, appRoot);
  assert.equal(upgraded.runtime.executable, electron);
  const store = createStore({root: updateRoot, trustedKeys, shellVersion: '1.4.0', shellApi: 1});
  const healthyRoot = store.verify(journal().current).root;
  const healthyFiles = snapshot(healthyRoot);
  const baselineSettings = fs.readFileSync(path.join(profile, 'settings.json'));
  writeJson(path.join(output, 'confirmed-state.json'), journal());
  record('signed v1.4.1 downloads, prior business stops, a new renderer reports health, and supervisor commits it');

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
  await settled(failedRecord.token, 'fallback-ready');
  assert.match(failedRecord.reason, /candidate-(?:exited|quiescent)/);
  assert.deepEqual(failedState.current, success.descriptor);
  assert.equal(failedState.previous, null);
  assert.deepEqual(failedRecord.descriptor, failure.descriptor);
  const candidate = events().find(entry => entry.token === failedRecord.token && entry.event === 'candidate-started');
  assert.ok(candidate && candidate.pid !== upgraded.pid && candidate.pid !== restored.pid);
  const secondHandoff = readJson(path.join(updateRoot, `handoff-${failedRecord.token}.json`));
  shutdownObservations.push(stoppedBusiness(upgraded.pid, failedRecord.token, secondHandoff.at));
  shutdownObservations.push(stoppedBusiness(candidate.pid, failedRecord.token, candidate.startedAt ?? Date.parse(candidate.at)));
  assert.equal(alive(restored.pid), true);
  const restoredState = await command(restored.pid, 'inspect');
  assert.equal(restoredState.state.opacity, 0.42);
  assert.equal(restoredState.state.version, '1.4.1');
  assert.equal(restoredState.state.shellVersion, '1.4.0');
  assert.match(restoredState.state.versionText, /v1\.4\.1/);
  assert.deepEqual(restoredState.errors, []);
  assert.equal(restoredState.runtime.isPackaged, packaged);
  assert.equal(restoredState.runtime.appPath, appRoot);
  assert.equal(restoredState.runtime.executable, electron);
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
  if (originalImmutable) assert.deepEqual(snapshot(runtimeRoot), originalFiles);
  assert.equal(sha256(fs.readFileSync(electron)), executableHash);
  assert.deepEqual(store.verify(success.descriptor).manifest.version, '1.4.1');
  assert.deepEqual(store.verify(failure.descriptor).manifest.version, '1.4.2');
  assert.equal(fs.existsSync(path.join(profile, 'updating')), false);
  record('version directories, host application files and Electron executable remain unchanged');
  const finalQuitRequestedAt = Date.now();
  await command(restored.pid, 'exit');
  await waitFor('fixture business quits after verification', () => {
    const lifecycle = lifecycleEvents().filter(event => event.pid === restored.pid && event.at >= finalQuitRequestedAt);
    return ['window-closed', 'process-exit', 'quit'].every(name => lifecycle.some(event => event.event === name));
  }, 15000);
  shutdownObservations.push({pid: restored.pid, token: null, businessQuitObserved: true,
    nativeExitObserved: nativeExitObserved(restored.pid), observedAt: Date.now()});
  writeJson(path.join(output, 'result.json'), {ok: true, mode: originalImmutable ? 'original-immutable' : packaged ? 'packaged-copy' : 'development', checks, original, upgraded, restored, failedState,
    shutdownObservations, lifecycle: lifecycleEvents(), executableHash, healthyFiles, builtinFiles});
  console.log('Evidence:', output);
}

run().catch(error => {
  fs.mkdirSync(output, {recursive: true});
  writeJson(path.join(output, 'result.json'), {ok: false, checks, error: error.stack, journal: journal(), events: events()});
  console.error(error.stack);
  process.exitCode = 1;
}).finally(async () => {
  await externalController?.close();
  // Only PIDs written by this isolated fixture and its supervisor are eligible.
  const starts = path.join(output, 'starts.ndjson');
  const owned = new Set(fs.existsSync(starts) ? fs.readFileSync(starts, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line).pid) : []);
  if (child?.pid) owned.add(child.pid);
  for (const event of events()) if (event.supervisorPid) owned.add(event.supervisorPid);
  const lifecyclePath = path.join(output, 'lifecycle.ndjson');
  const quitting = new Set(fs.existsSync(lifecyclePath) ? fs.readFileSync(lifecyclePath, 'utf8').trim().split(/\r?\n/).filter(Boolean)
    .map(line => JSON.parse(line)).filter(event => ['before-quit', 'quit'].includes(event.event)).map(event => event.pid) : []);
  for (const pid of owned) if (alive(pid) && !quitting.has(pid)) { try { process.kill(pid); } catch {} }
  // Preserve a process already in app.quit for exit-boundary diagnosis instead
  // of turning its natural shutdown into a test-generated termination.
  child?.unref();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  if (stdout !== undefined) fs.closeSync(stdout);
  if (stderr !== undefined) fs.closeSync(stderr);
});
