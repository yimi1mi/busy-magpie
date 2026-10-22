'use strict';

const { app, ipcMain, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createStore } = require('./store.cjs');
const { createJournal, writeJson, alive } = require('./journal.cjs');
const { createUpdater } = require('./updater.cjs');
const { compareVersions } = require('./package.cjs');
const { validateRecovery } = require('./recovery.cjs');
const trustedKeys = require('./trusted-keys.json');
const config = require('./config.json');

const preview = process.argv.includes('--preview');
app.setName(preview ? 'Busy Magpie Preview' : 'Busy Magpie');
if (preview) app.setPath('userData', path.resolve(process.env.BUSY_MAGPIE_PREVIEW_DIR || path.join(app.getPath('appData'), 'Busy Magpie Preview')));
const userData = app.getPath('userData');
const root = path.join(userData, 'business-updates');
fs.mkdirSync(root, { recursive: true });
function log(message) {
  try { fs.appendFileSync(path.join(root, 'update.log'), `${new Date().toISOString()} ${message}\n`); } catch { /* logging cannot prevent startup */ }
}
let shutdownToken = process.argv.find(arg => arg.startsWith('--business-update-token='))?.split('=')[1];
let nodeExited = false;
let shutdownRegistered = false;
process.once('exit', () => { nodeExited = true; });
function registerShutdown() {
  if (shutdownRegistered) return;
  shutdownRegistered = true;
  // Register after business listeners (also on a partial startup failure).
  // Shell API 1 forbids business persistence in app's quit listeners: all
  // settings writes are synchronous and finish before the Node exit event.
  app.on('quit', () => {
    if (!nodeExited || !/^[a-f0-9]{48}$/.test(shutdownToken || '') || BrowserWindow.getAllWindows().length !== 0) return;
    try {
      app.releaseSingleInstanceLock();
      writeJson(path.join(root, `shutdown-${shutdownToken}-${process.pid}.json`), {
        token: shutdownToken, pid: process.pid, at: Date.now(), phase: 'quiescent',
      });
      log(`business quiescent pid ${process.pid}, token ${shutdownToken}; native process cleanup may continue`);
    } catch (error) { log(`shutdown handshake failed: ${error.message}`); }
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  try {
    const builtin = { root: path.resolve(__dirname, '..'), version: app.getVersion() };
    const store = createStore({ root, trustedKeys, shellVersion: app.getVersion(), shellApi: 1 });
    const journal = createJournal({ root, builtin, store });
    const token = process.argv.find(arg => arg.startsWith('--business-update-token='))?.split('=')[1];
    const rollbackToken = process.argv.find(arg => arg.startsWith('--business-rollback-token='))?.split('=')[1];
    if (!token) {
      let owner;
      try { owner = JSON.parse(fs.readFileSync(path.join(root, 'supervisor.lock', 'owner.json'), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
      if (owner && alive(owner.pid)) {
        let authorizedFallback = false;
        if (/^[a-f0-9]{48}$/.test(rollbackToken || '')) {
          try {
            const marker = JSON.parse(fs.readFileSync(path.join(root, `handoff-${rollbackToken}.json`), 'utf8'));
            authorizedFallback = marker.token === rollbackToken && marker.pid === owner.pid && marker.ready === true;
          } catch { /* An unverified fallback token cannot bypass the supervisor. */ }
        }
        if (!authorizedFallback) {
          log('normal launch deferred: update supervisor is active');
          app.exit(0);
          return;
        }
      }
      let interrupted;
      try { interrupted = journal.read().pending; }
      catch (error) { if (error.code !== 'CORRUPT_JOURNAL') throw error; }
      const quiescentCandidate = interrupted?.status === 'booting'
        && require('./restart-worker.cjs').readQuiescence({ root, token: interrupted.token }, interrupted.bootPid, interrupted.bootStartedAt);
      if (interrupted?.status === 'booting' && (!alive(interrupted.bootPid) || quiescentCandidate)) {
        const configPath = path.join(root, 'transactions', interrupted.token, 'handoff.json');
        const handoff = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const expectedTarget = path.join(userData, 'settings.json');
        const expectedBackup = path.join(path.dirname(configPath), 'settings.json');
        if (handoff.token !== interrupted.token || handoff.root !== root || handoff.settingsBackup?.target !== expectedTarget
          || handoff.settingsBackup?.path !== expectedBackup) throw new Error('Interrupted update has an invalid settings recovery record');
        validateRecovery(handoff);
        require('./restart-worker.cjs').restoreSettings(handoff, (event, detail) => log(`${event} ${JSON.stringify(detail)}`));
        journal.rollback(interrupted.token, 'interrupted-candidate-boot');
        log(`restored settings after interrupted candidate ${interrupted.descriptor.version}`);
      } else if (interrupted?.status === 'prepared') {
        journal.rollback(interrupted.token, 'interrupted-before-handoff');
      }
    }
    const selection = journal.select(token);
    const args = process.argv.slice(app.isPackaged ? 1 : 2).filter(arg => !/^--business-(update|rollback)-token=/.test(arg));
    const launchArgs = app.isPackaged ? args : [app.getAppPath(), ...args];
    const testFeed = (!app.isPackaged || preview) && process.env.BUSY_MAGPIE_DEV_UPDATE_FEED;
    const updater = createUpdater({ app, root, builtin, shellVersion: app.getVersion(), currentVersion: selection.version,
      store, journal, trustedKeys, feedUrl: testFeed || config.businessFeed, allowLocal: Boolean(testFeed),
      hostUpdater: testFeed ? null : require('electron-updater').autoUpdater,
      enabled: Boolean(testFeed) || (app.isPackaged && !preview), launchArgs, log,
      onHandoff: token => { shutdownToken = token; } });
    const lastFailure = journal.read().failures.at(-1);
    global.__busyShell = Object.freeze({ businessVersion: selection.version, shellVersion: app.getVersion(),
      recoveryMessage: lastFailure?.descriptor && compareVersions(lastFailure.descriptor.version, selection.version) > 0
        && /candidate|health|current-invalid|previous-invalid/.test(lastFailure.reason)
        ? `v${lastFailure.descriptor.version} 上次更新未成功，当前运行 v${selection.version}。` : '',
      ownsInstanceLock: true, updater, updatesEnabled: Boolean(testFeed) || (app.isPackaged && !preview),
      updateInProgress: Boolean(selection.token || rollbackToken),
      attachBlur: window => require('./windows-blur.cjs').attachBlur(window) });
    // The marker follows an actual renderer/bootstrap round trip. Being offline
    // is a supported state and is deliberately not a failed startup condition.
    const expectedUrl = pathToFileURL(path.join(selection.root, 'web', 'index.html')).href;
    let checkingHealth = false;
    let healthTimer;
    async function reportHealth(sender) {
      if (checkingHealth || sender.isDestroyed() || sender.getURL() !== expectedUrl) return;
      if (selection.token && journal.read().pending?.token !== selection.token) {
        clearInterval(healthTimer);
        return;
      }
      const window = BrowserWindow.fromWebContents(sender);
      if (!window || window.isDestroyed()) return;
      checkingHealth = true;
      try {
        const result = await sender.executeJavaScript(`window.busy.bootstrap().then(data => ({version:data.version, settings:!!data.settings, documentReady:document.readyState === 'complete', root:!!document.getElementById('app')}))`);
        if (result.version !== selection.version || !result.settings || !result.root || !result.documentReady) throw new Error('renderer bootstrap did not complete');
        if (selection.token) journal.ready(selection.token, process.pid);
        writeJson(path.join(root, 'runtime-ready.json'), { pid: process.pid, version: selection.version, at: Date.now() });
      } catch (error) { log(`candidate health failed: ${error.stack || error.message}`); }
      finally { checkingHealth = false; }
    }
    ipcMain.on('busy:ready', event => {
      if (event.sender.getURL() !== expectedUrl) return;
      reportHealth(event.sender).catch(error => log(`health: ${error.message}`));
      if (selection.token && !healthTimer) {
        healthTimer = setInterval(() => reportHealth(event.sender).catch(error => log(`health: ${error.message}`)), 1000);
        healthTimer.unref();
      }
    });
    log(`load business ${selection.version} (${selection.descriptor?.id || 'builtin'}), shell ${app.getVersion()}`);
    require(path.join(selection.root, 'src', 'main.js'));
    registerShutdown();
  } catch (error) {
    log(`startup failed: ${error.stack || error.message}`);
    // The supervisor owns rollback. A failed candidate must really exit, not
    // remain in a main-process exception handler with no usable window.
    registerShutdown();
    app.exit(1);
  }
}
