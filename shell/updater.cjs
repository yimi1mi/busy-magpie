'use strict';

const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { compareVersions } = require('./package.cjs');
const { atomicWrite, writeJson } = require('./journal.cjs');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function compare(a, b) {
  return compareVersions(String(a).replace(/^v/, ''), String(b).replace(/^v/, ''));
}
function safeUrl(value, base, allowLocal = false) {
  const url = new URL(value, base);
  if (url.username || url.password || !(url.protocol === 'https:' || (allowLocal && url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))) {
    throw new Error('更新地址必须使用 HTTPS');
  }
  return url.href;
}
async function readResponse(url, { limit, timeout = 30000, allowLocal = false, onProgress, fetchImpl = fetch }) {
  const signal = AbortSignal.timeout(timeout);
  let address = safeUrl(url, undefined, allowLocal);
  let response;
  for (let redirects = 0; ; redirects++) {
    response = await fetchImpl(address, { signal, cache: 'no-store', redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    await response.body?.cancel();
    if (redirects >= 5) throw new Error('更新地址重定向次数过多');
    const location = response.headers.get('location');
    if (!location) throw new Error('更新服务返回了空重定向');
    address = safeUrl(location, address, allowLocal);
  }
  if (response.status === 404) { await response.body?.cancel(); return null; }
  if (!response.ok) { await response.body?.cancel(); throw new Error(`更新服务返回 HTTP ${response.status}`); }
  if (response.url) safeUrl(response.url, undefined, allowLocal);
  const total = Number(response.headers.get('content-length')) || 0;
  if (total > limit) { await response.body?.cancel(); throw new Error('更新文件超过大小限制'); }
  const chunks = [];
  let transferred = 0;
  for await (const chunk of response.body) {
    transferred += chunk.length;
    if (transferred > limit) throw new Error('更新文件超过大小限制');
    chunks.push(chunk);
    onProgress?.({ total, transferred, percent: total ? transferred / total * 100 : 0 });
  }
  return Buffer.concat(chunks);
}

function createUpdater({ app, root, builtin, shellVersion, currentVersion, store, journal, trustedKeys, feedUrl,
  hostUpdater, allowLocal = false, enabled = true, launchArgs = [], fetchImpl = fetch, log = () => {}, onHandoff = () => {} }) {
  const updater = new EventEmitter();
  // Consumers receive errors through their existing update status panel.
  updater.on('error', error => log(`updater: ${error.stack || error.message}`));
  let target = null;
  let staged = null;
  let downloading = null;
  let checking = null;
  if (hostUpdater) {
    hostUpdater.autoDownload = false;
    hostUpdater.autoInstallOnAppQuit = false;
    hostUpdater.allowPrerelease = false;
    hostUpdater.logger = { info: log, warn: log, error: log, debug: log };
    hostUpdater.on('error', error => { if (target?.kind === 'shell') updater.emit('error', error); });
    hostUpdater.on('download-progress', value => { if (target?.kind === 'shell') updater.emit('download-progress', value); });
    hostUpdater.on('update-downloaded', () => { if (target?.kind === 'shell') updater.emit('update-downloaded'); });
  }
  updater.checkForUpdates = () => {
    if (checking) return checking;
    if (downloading || staged) return Promise.resolve({ updateInfo: target });
    checking = (async () => {
      updater.emit('checking-for-update');
      let business = null;
      let quarantined = '';
      if (enabled && feedUrl) {
        const bytes = await readResponse(feedUrl, { limit: 256 * 1024, allowLocal, fetchImpl });
        if (bytes) {
          const feed = JSON.parse(bytes.toString('utf8'));
          if (feed.format !== 1 || !/^\d+\.\d+\.\d+$/.test(feed.version) || !/^\d+\.\d+\.\d+$/.test(feed.minShellVersion)
            || !Number.isSafeInteger(feed.size) || feed.size <= 0 || feed.size > 32 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(feed.sha256)) {
            throw new Error('业务更新清单格式无效');
          }
          if (compare(feed.version, currentVersion) > 0 && feed.shellApi === 1 && compare(shellVersion, feed.minShellVersion) >= 0) {
            if (journal.read().failures.some(item => item.descriptor?.version === feed.version && /candidate|health|current-invalid|previous-invalid/.test(item.reason))) {
              quarantined = feed.version;
            } else {
              business = { ...feed, kind: 'business', packageUrl: safeUrl(feed.packageUrl, feedUrl, allowLocal),
                releaseNotes: String(feed.notes || ''), releaseUrl: 'https://github.com/yimi1mi/busy-magpie/releases/tag/business-stable' };
            }
          }
        }
      }
      // Shell releases keep their existing feed for pre-1.4 launchers. Business
      // packages live on a separate tag and never become GitHub's latest release.
      let host = null;
      if (enabled && hostUpdater) {
        try { host = await hostUpdater.checkForUpdates(); }
        catch (error) {
          if (!business) throw error;
          log(`shell update check unavailable: ${error.message}`);
        }
      }
      const hostInfo = host?.updateInfo;
      target = hostInfo && compare(hostInfo.version, shellVersion) > 0
        ? { ...hostInfo, kind: 'shell' } : business;
      staged = null;
      if (target) updater.emit('update-available', target);
      else updater.emit('update-not-available', { version: currentVersion, kind: 'business' });
      if (!target && quarantined) updater.emit('error', new Error(`v${quarantined} 上次更新未成功，已保留 v${currentVersion}；等待后续版本，不重复尝试该版本。`));
      return { updateInfo: target || { version: currentVersion, kind: 'business' } };
    })().catch(error => { updater.emit('error', error); throw error; }).finally(() => { checking = null; });
    return checking;
  };
  updater.downloadUpdate = () => {
    if (downloading) return downloading;
    downloading = (async () => {
      if (!target) throw new Error('请先检查更新');
      if (target.kind === 'shell') return hostUpdater.downloadUpdate();
      const bytes = await readResponse(target.packageUrl, { limit: 32 * 1024 * 1024, timeout: 120000, allowLocal, fetchImpl,
        onProgress: progress => updater.emit('download-progress', { ...progress, total: target.size, percent: progress.transferred / target.size * 100 }) });
      if (!bytes || bytes.length !== target.size || crypto.createHash('sha256').update(bytes).digest('hex') !== target.sha256) {
        throw new Error('业务包下载校验失败');
      }
      const descriptor = store.stage(bytes);
      if (descriptor.version !== target.version) throw new Error('业务包版本与更新清单不一致');
      staged = descriptor;
      updater.emit('update-downloaded');
      return [descriptor.id];
    })().catch(error => { updater.emit('error', error); throw error; }).finally(() => { downloading = null; });
    return downloading;
  };
  updater.quitAndInstall = async () => {
    if (target?.kind === 'shell') return hostUpdater.quitAndInstall(true, true);
    if (!staged) throw new Error('业务包尚未通过校验');
    const token = journal.prepare(staged);
    let child;
    try {
      const transaction = path.join(root, 'transactions', token);
      fs.mkdirSync(transaction, { recursive: true });
      const settingsTarget = path.join(app.getPath('userData'), 'settings.json');
      const settingsPath = path.join(transaction, 'settings.json');
      const existed = fs.existsSync(settingsTarget);
      if (existed) atomicWrite(settingsPath, fs.readFileSync(settingsTarget));
      const config = { root, builtin, shellVersion, shellApi: 1, trustedKeys, token, oldPid: process.pid,
        executable: process.execPath, args: launchArgs,
        updatingMarker: path.join(app.getPath('userData'), 'updating'),
        settingsBackup: { path: settingsPath, target: settingsTarget, existed } };
      const configPath = path.join(transaction, 'handoff.json');
      writeJson(configPath, config);
      child = spawn(process.execPath, [path.join(__dirname, 'restart-worker.cjs'), configPath], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, detached: true, stdio: 'ignore', windowsHide: true,
      });
      let launchError = null;
      child.on('error', error => { launchError = error; });
      const deadline = Date.now() + 10000;
      let accepted = false;
      while (Date.now() < deadline) {
        if (launchError) throw launchError;
        if (child.exitCode !== null) throw new Error(`更新监督进程提前退出 (${child.exitCode})`);
        try {
          const marker = JSON.parse(fs.readFileSync(path.join(root, `handoff-${token}.json`), 'utf8'));
          if (marker.ready && marker.token === token && marker.pid === child.pid) { accepted = true; break; }
        } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
        await sleep(50);
      }
      if (!accepted) throw new Error('更新监督进程未接管，应用继续运行');
      onHandoff(token);
      child.unref();
      log(`business update handoff ${currentVersion} -> ${staged.version}, worker ${child.pid}, token ${token}`);
      // Let the renderer's install IPC receive its result before closing it.
      setImmediate(() => app.quit());
    } catch (error) {
      journal.rollback(token, `handoff failed: ${error.message}`);
      try { fs.rmSync(path.join(app.getPath('userData'), 'updating'), { force: true }); } catch { /* best effort */ }
      child?.unref();
      updater.emit('error', error);
      throw error;
    }
  };
  return updater;
}

module.exports = { createUpdater, safeUrl, readResponse, compare };
