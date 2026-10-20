// Busy Magpie launcher plugin.
//
// magpie loads this file in its Bun plugin host. The host starts when the
// plugin is first used, and this file then starts the desktop widget if it is
// already installed. The gateway request is always passed through untouched.

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, promises as fsp, readFileSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RELEASE = 'https://github.com/yimi1mi/busy-magpie/releases/latest';
const API = 'https://api.github.com/repos/yimi1mi/busy-magpie/releases/latest';
const EXE = 'Busy Magpie.exe';

function pluginVersion() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf8'));
    return String(pkg.version || '');
  } catch {
    return '';
  }
}

const PLUGIN_VERSION = pluginVersion();

let launched = false;
let lastEnsure = 0;
let installing = false;
let checking = false;
let installTried = false;
let warned = false;
let releaseCache = null;
// A newer release waits for a quiet moment rather than interrupting a look.
let pendingUpdate = '';
let notifiedUpdate = '';
let lastRequest = Date.now();

function psQuote(value) {
  return String(value).replace(/'/g, "''");
}

function notify(title, message) {
  try {
    if (process.platform === 'win32') {
      const script = [
        'Add-Type -AssemblyName System.Windows.Forms',
        'Add-Type -AssemblyName System.Drawing',
        '$n = New-Object System.Windows.Forms.NotifyIcon',
        '$n.Icon = [System.Drawing.SystemIcons]::Information',
        '$n.Visible = $true',
        `$n.ShowBalloonTip(6000, '${psQuote(title)}', '${psQuote(message)}', [System.Windows.Forms.ToolTipIcon]::Info)`,
        'Start-Sleep -Seconds 7',
        '$n.Dispose()',
      ].join('; ');
      const encoded = Buffer.from(script, 'utf16le').toString('base64');
      const child = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded,
      ], { detached: true, stdio: 'ignore', windowsHide: true });
      child.on('error', () => {});
      child.unref();
    } else if (process.platform === 'darwin') {
      const esc = (value) => String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const child = spawn('osascript', [
        '-e', `display notification "${esc(message)}" with title "${esc(title)}"`,
      ], { detached: true, stdio: 'ignore' });
      child.on('error', () => {});
      child.unref();
    }
  } catch {
    // Notifications are best effort; they must never stop the launcher.
  }
}

function candidates() {
  const out = [];
  const custom = process.env.BUSY_MAGPIE_APP;
  if (custom) out.push(custom);

  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA;
    const roaming = process.env.APPDATA;
    const programFiles = process.env.PROGRAMFILES;
    const programFilesX86 = process.env['PROGRAMFILES(X86)'];
    if (local) {
      out.push(path.join(local, 'Programs', 'Busy Magpie', EXE));
      out.push(path.join(local, 'Programs', 'busy-magpie', EXE));
      out.push(path.join(local, 'Programs', 'BusyMagpie', EXE));
      out.push(path.join(local, 'Busy Magpie', EXE));
    }
    if (roaming) {
      // A portable copy next to the settings directory is unusual, but
      // accepting it costs nothing after the standard per-user locations.
      out.push(path.join(roaming, '..', 'Local', 'Programs', 'Busy Magpie', EXE));
      out.push(path.join(roaming, 'Busy Magpie', EXE));
      out.push(path.join(roaming, 'Programs', 'Busy Magpie', EXE));
    }
    if (programFiles) out.push(path.join(programFiles, 'Busy Magpie', EXE));
    if (programFilesX86) out.push(path.join(programFilesX86, 'Busy Magpie', EXE));
  } else if (process.platform === 'darwin') {
    out.push('/Applications/Busy Magpie.app/Contents/MacOS/Busy Magpie');
    out.push(path.join(homedir(), 'Applications', 'Busy Magpie.app', 'Contents', 'MacOS', 'Busy Magpie'));
  }

  return out;
}

function findApp() {
  for (const file of candidates()) {
    try {
      if (file && existsSync(file)) return file;
    } catch {
      // A malformed override simply does not match.
    }
  }
  return '';
}

function spawnApp(exe, firstInstall = false) {
  try {
    // Electron switches to a headless Node mode when this leaks in from a
    // terminal that launched magpie. The GUI must inherit everything else.
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    if (PLUGIN_VERSION) env.BUSY_MAGPIE_PLUGIN_VERSION = PLUGIN_VERSION;
    if (firstInstall) env.BUSY_MAGPIE_FIRST_INSTALL = '1';
    const child = spawn(exe, [], {
      cwd: path.dirname(exe),
      env,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', (error) => {
      console.warn(`[busy-magpie] could not start ${exe}: ${error.message}`);
    });
    child.unref();
    launched = true;
    console.log(`[busy-magpie] started ${exe}`);
  } catch (error) {
    console.warn(`[busy-magpie] could not start ${exe}: ${error.message}`);
  }
}

async function getRelease() {
  if (releaseCache) return releaseCache;
  const response = await fetch(API, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'busy-magpie-plugin' },
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
  releaseCache = await response.json();
  return releaseCache;
}

function versionOf(exe) {
  if (process.platform !== 'win32') return '';
  // The app writes its real package version here. The PE ProductVersion can
  // lag behind when electron-builder's rcedit pass fails, so prefer the marker.
  try {
    const marker = path.join(process.env.APPDATA || '', 'Busy Magpie', 'version');
    const marked = readFileSync(marker, 'utf8').trim().replace(/^v/i, '');
    if (marked) return marked;
  } catch {
    // No marker yet: this is an older install or a first run.
  }
  try {
    const escaped = exe.replace(/'/g, "''");
    const out = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `(Get-Item -LiteralPath '${escaped}').VersionInfo.ProductVersion`,
    ], { encoding: 'utf8', timeout: 1500, windowsHide: true });
    return String(out || '').trim().replace(/^v/i, '');
  } catch {
    return '';
  }
}

function compareVersions(a, b) {
  const left = String(a || '').replace(/^v/i, '').split(/[.+-]/).map((part) => Number(part) || 0);
  const right = String(b || '').replace(/^v/i, '').split(/[.+-]/).map((part) => Number(part) || 0);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const delta = (left[i] || 0) - (right[i] || 0);
    if (delta !== 0) return delta < 0 ? -1 : 1;
  }
  return 0;
}

function appRunning() {
  if (process.platform !== 'win32') return false;
  try {
    const out = execFileSync('tasklist.exe', [
      '/FI', 'IMAGENAME eq Busy Magpie.exe', '/NH',
    ], { encoding: 'utf8', timeout: 1200, windowsHide: true });
    return out.toLowerCase().includes('busy magpie.exe');
  } catch {
    return false;
  }
}

async function installApp() {
  if (process.platform !== 'win32') return '';
  console.log('[busy-magpie] downloading the latest release installer');
  notify('Busy Magpie', '正在下载安装包，完成后会自动打开…');

  const release = await getRelease();
  const asset = (release.assets || []).find((item) => (
    !/sha256/i.test(item.name) && /win-x64\.exe$/i.test(item.name)
  ));
  if (!asset) throw new Error('no Windows x64 installer in the latest release');

  const download = await fetch(asset.browser_download_url, {
    headers: { 'User-Agent': 'busy-magpie-plugin' },
  });
  if (!download.ok) throw new Error(`download answered ${download.status}`);
  const body = Buffer.from(await download.arrayBuffer());
  if (asset.digest && asset.digest.startsWith('sha256:')) {
    const got = createHash('sha256').update(body).digest('hex');
    if (got !== asset.digest.slice(7).toLowerCase()) {
      throw new Error('installer checksum does not match the release');
    }
  }

  const installer = path.join(tmpdir(), 'busy-magpie-setup.exe');
  await fsp.writeFile(installer, body);
  console.log(`[busy-magpie] installing ${release.tag_name} silently`);
  notify('Busy Magpie', '下载完成，正在安装…');
  await new Promise((resolve, reject) => {
    const child = spawn(installer, ['/S'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`installer exited with ${code}`));
    });
  });
  await fsp.rm(installer, { force: true });
  return findApp();
}

// The card touches this file while it runs, so a request can tell a hidden
// window from an exited process: hidden still writes, exited goes stale.
const ALIVE_MS = 30000;

function heartbeatPath() {
  if (process.platform === 'win32') {
    const roaming = process.env.APPDATA || path.join(homedir(), 'AppData', 'Roaming');
    return path.join(roaming, 'Busy Magpie', 'alive');
  }
  return path.join(homedir(), 'Library', 'Application Support', 'Busy Magpie', 'alive');
}

// 'unknown' is an app older than the heartbeat: only the launched flag then.
// 'off' means the user switched keep-alive off, so a quit stays a quit.
function appState() {
  const file = heartbeatPath();
  try {
    const stat = statSync(file);
    let keepAlive = true;
    try {
      const beat = JSON.parse(readFileSync(file, 'utf8'));
      if (beat && beat.keepAlive === false) keepAlive = false;
    } catch {
      // An older heartbeat is a bare timestamp: keep-alive was always on.
    }
    if (!keepAlive) return 'off';
    return Date.now() - stat.mtimeMs < ALIVE_MS ? 'alive' : 'dead';
  } catch (error) {
    return error?.code === 'ENOENT' ? 'unknown' : 'dead';
  }
}
function ensureApp() {
  if (process.env.BUSY_MAGPIE_NO_LAUNCH === '1' || installing || checking) return;

  const state = appState();
  if (state === 'alive') {
    launched = true;
    return;
  }
  if (state === 'off') return;
  if (state === 'unknown' && launched) return;
  // The card was quit or crashed: start it again, at most once a minute, so
  // a burst of requests doesn't spawn a process each.
  const now = Date.now();
  if (now - lastEnsure < 60000) return;
  lastEnsure = now;
  launched = false;

  const existing = findApp();
  if (existing) {
    checking = true;
    getRelease()
      .then(async (release) => {
        const target = String(release?.tag_name || '');
        const current = versionOf(existing);
        if (!current || !target || compareVersions(current, target) >= 0) {
          console.log(`[busy-magpie] installed ${current || '?'}, target ${target || '?'}`);
          spawnApp(existing);
          return;
        }

        if (appRunning()) {
          console.warn(`[busy-magpie] ${current} -> ${target} available; app is running`);
          // Not while someone is watching: the swap waits for a quiet five
          // minutes, then quits the card, installs and starts it again.
          pendingUpdate = target;
          if (notifiedUpdate !== target) {
            notifiedUpdate = target;
            notify('Busy Magpie', `发现 ${target}，空闲几分钟后自动更新`);
          }
          spawnApp(existing);
          return;
        }

        console.log(`[busy-magpie] updating ${current} -> ${target}`);
        notify('Busy Magpie', `发现新版本 ${target}，正在更新…`);
        installing = true;
        try {
          const installed = await installApp();
          if (installed) spawnApp(installed);
          else spawnApp(existing);
        } catch (error) {
          console.warn(`[busy-magpie] update failed: ${error.message}`);
          notify('Busy Magpie', '自动更新失败，已启动当前版本');
          spawnApp(existing);
        } finally {
          installing = false;
        }
      })
      .catch(() => {
        // GitHub being unreachable must not stop an installed app from opening.
        spawnApp(existing);
      })
      .finally(() => { checking = false; });
    return;
  }

  if (process.env.BUSY_MAGPIE_NO_INSTALL === '1' || installTried) {
    if (!warned) {
      warned = true;
      console.warn(
        `[busy-magpie] app not found; install it from ${RELEASE} `
        + 'or set BUSY_MAGPIE_APP to Busy Magpie.exe',
      );
    }
    return;
  }

  installTried = true;
  installing = true;
  installApp()
    .then((installed) => {
      if (installed) {
        notify('Busy Magpie', '安装完成，正在启动桌面卡片');
        spawnApp(installed, true);
      } else if (!warned) {
        warned = true;
        console.warn(`[busy-magpie] installed, but ${EXE} was not found`);
        notify('Busy Magpie', '安装完成，但没有找到启动文件');
      }
    })
    .catch((error) => {
      console.warn(`[busy-magpie] install failed: ${error.message}; `
        + `download it from ${RELEASE}`);
      notify('Busy Magpie', '自动安装失败，请从 GitHub Releases 手动安装');
    })
    .finally(() => { installing = false; });
}

// A card that stays open would otherwise never update: the check refuses to
// install over a running app. So a newer release waits here until nothing has
// gone through the gateway for a while, and then the swap happens.
const IDLE_MS = 5 * 60 * 1000;

async function applyPendingUpdate() {
  if (!pendingUpdate || installing || checking) return;
  if (Date.now() - lastRequest < IDLE_MS) return;
  if (!appRunning()) return; // the next launch's check installs it

  const target = pendingUpdate;
  pendingUpdate = '';
  installing = true;
  try {
    console.log(`[busy-magpie] idle: updating to ${target}`);
    notify('Busy Magpie', `正在更新到 ${target}…`);
    try {
      execFileSync('taskkill.exe', ['/IM', EXE, '/F'], { timeout: 5000, windowsHide: true });
    } catch {
      // It may have exited on its own between the check and the kill.
    }
    await new Promise((resolve) => setTimeout(resolve, 900));
    const installed = await installApp();
    if (installed) spawnApp(installed);
  } catch (error) {
    console.warn(`[busy-magpie] idle update failed: ${error.message}`);
    notify('Busy Magpie', '自动更新失败，已保留当前版本');
  } finally {
    installing = false;
  }
}

setInterval(() => { applyPendingUpdate().catch(() => {}); }, 60000);

// Start as soon as the hook module is loaded. onRequest remains a fallback
// for hosts that import this file before spawning their first request.
ensureApp();

export function onRequest(body) {
  lastRequest = Date.now();
  ensureApp();
  return body;
}
