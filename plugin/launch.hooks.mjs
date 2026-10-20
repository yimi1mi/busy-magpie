// Busy Magpie launcher plugin.
//
// magpie loads this file in its Bun plugin host. The host starts when the
// plugin is first used, and this file then starts the desktop widget if it is
// already installed. The gateway request is always passed through untouched.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, promises as fsp } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

const RELEASE = 'https://github.com/yimi1mi/busy-magpie/releases/latest';
const API = 'https://api.github.com/repos/yimi1mi/busy-magpie/releases/latest';
const EXE = 'Busy Magpie.exe';

let launched = false;
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

async function installApp() {
  if (process.platform !== 'win32') return '';
  console.log('[busy-magpie] app not installed; downloading the latest release');
  notify('Busy Magpie', '正在下载安装包，完成后会自动打开…');

  const meta = await fetch(API, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'busy-magpie-plugin' },
  });
  if (!meta.ok) throw new Error(`GitHub answered ${meta.status}`);
  const release = await meta.json();
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

function ensureApp() {
  if (process.env.BUSY_MAGPIE_NO_LAUNCH === '1' || launched || installing) return;
  const existing = findApp();
  if (existing) {
    spawnApp(existing);
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
        spawnApp(installed);
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

// Start as soon as the hook module is loaded. onRequest remains a fallback
// for hosts that import this file before spawning their first request.
ensureApp();

export function onRequest(body) {
  ensureApp();
  return body;
}
