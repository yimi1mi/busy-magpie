// Busy Magpie launcher plugin.
//
// magpie loads this file in its Bun plugin host. The host starts when the
// plugin is first used, and this file then starts the desktop widget if it is
// already installed, or downloads and installs a release first. The gateway
// request is always passed through untouched.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import launchPolicy from '../src/launch-policy.cjs';

import { installApp, RELEASE } from './install.mjs';
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
let installTried = false;
let warned = false;

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

function spawnApp(exe) {
  try {
    // Electron switches to a headless Node mode when this leaks in from a
    // terminal that launched magpie. The GUI must inherit everything else.
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    if (PLUGIN_VERSION) env.BUSY_MAGPIE_PLUGIN_VERSION = PLUGIN_VERSION;
    const child = spawn(exe, [], {
      cwd: path.dirname(exe),
      env,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', (error) => {
      launched = false;
      console.warn(`[busy-magpie] could not start ${exe}: ${error.message}`);
    });
    child.unref();
    child.once('spawn', () => {
      launched = true;
      console.log(`[busy-magpie] started ${exe}`);
    });
  } catch (error) {
    console.warn(`[busy-magpie] could not start ${exe}: ${error.message}`);
  }
}

// The card touches this file while it runs, so a request can tell a hidden
// window from an exited process: hidden still writes, exited goes stale.
const ALIVE_MS = 30000;

function supportDir() {
  if (process.platform === 'win32') {
    const roaming = process.env.APPDATA || path.join(homedir(), 'AppData', 'Roaming');
    return path.join(roaming, 'Busy Magpie');
  }
  return path.join(homedir(), 'Library', 'Application Support', 'Busy Magpie');
}

function heartbeatPath() {
  return path.join(supportDir(), 'alive');
}

// 'unknown' is an app older than the heartbeat: only the launched flag then.
// 'off' means the user switched keep-alive off, so a quit stays a quit.
function appState() {
  const file = heartbeatPath();
  try {
    const stat = statSync(file);
    let beat = null;
    try {
      beat = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      // An older heartbeat is a bare timestamp: keep-alive was always on.
    }
    return launchPolicy.heartbeatState(beat, stat.mtimeMs, Date.now(), ALIVE_MS);
  } catch (error) {
    return error?.code === 'ENOENT' ? 'unknown' : 'dead';
  }
}
// electron-updater has quit the card and is replacing its files: starting it
// now would hold the very files the installer is writing. The card writes
// this marker just before it quits and removes it when it comes back.
const UPDATING_MS = 10 * 60 * 1000;

function updateInProgress() {
  try {
    const stat = statSync(path.join(supportDir(), 'updating'));
    return Date.now() - stat.mtimeMs < UPDATING_MS;
  } catch {
    return false;
  }
}

function ensureApp() {
  if (process.env.BUSY_MAGPIE_NO_LAUNCH === '1' || installing) return;
  if (updateInProgress()) return;

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
    // Updates belong to the card (electron-updater); the launcher only starts
    // what is installed. Starting it during an install would hold the files
    // the installer has to replace, so an install in progress says so.
    spawnApp(existing);
    return;
  }
  if (process.env.BUSY_MAGPIE_NO_INSTALL === '1' || installTried) {
    if (!warned) {
      warned = true;
      console.warn(
        `[busy-magpie] app not found; install it from ${RELEASE} `
        + 'or set BUSY_MAGPIE_APP to the application executable',
      );
    }
    return;
  }

  installTried = true;
  installing = true;
  installApp({ findApp, notify })
    .then((installed) => {
      if (installed) {
        notify('Busy Magpie', '安装完成，正在启动桌面卡片');
        spawnApp(installed);
      } else {
        throw new Error('installation did not return an application executable');
      }
    })
    .catch((error) => {
      console.warn(`[busy-magpie] install failed: ${error.message}; `
        + `download it from ${RELEASE}`);
      notify('Busy Magpie', '自动安装失败，请从 GitHub Releases 手动安装');
    })
    .finally(() => { installing = false; });
}

// Start as soon as the hook module is loaded. onRequest remains a fallback
// for hosts that import this file before spawning their first request.
ensureApp();

export function onRequest(body) {
  ensureApp();
  return body;
}
