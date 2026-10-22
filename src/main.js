'use strict';

const {
  app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, screen, shell, Notification,
  globalShortcut, clipboard,
} = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { autoUpdater } = require('electron-updater');
const { heartbeat } = require('./launch-policy.cjs');

app.setName('Busy Magpie');

const WIDTH = 632;
const HEIGHT = 432;
// The card is drawn on a 600×400 canvas inside 16px of padding. Keeping the
// window at that shape is what lets the canvas scale up to fill it instead of
// leaving dark bands above and below.
const CARD_RATIO = 600 / 400;
const CARD_PAD = 32;

function heightForWidth(width) {
  return Math.round((width - CARD_PAD) / CARD_RATIO) + CARD_PAD;
}

function widthForHeight(height) {
  return Math.round((height - CARD_PAD) * CARD_RATIO) + CARD_PAD;
}
const ASSETS = path.join(__dirname, '..', 'assets');
const RENDERER = path.join(__dirname, '..', 'web', 'index.html');
const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';
const START_IN_LAYOUT = process.argv.includes('--layout');
const START_IN_SETTINGS = process.argv.includes('--settings');
const FIRST_INSTALL = process.env.BUSY_MAGPIE_FIRST_INSTALL === '1';
const PLUGIN_VERSION = process.env.BUSY_MAGPIE_PLUGIN_VERSION || '';
// A card that stays open all day should learn about a release the same day,
// so it looks again every hour.
const UPDATE_CHECK_MS = 60 * 60 * 1000;

let win = null;
let firstRunOpen = FIRST_INSTALL;
let settingsOpen = false;
let settingsClosing = false;
let quickMenuOpen = false;
let rendererReady = false;
let pendingSettings = false;
let pendingPanelMode = 'settings';
let currentPanelMode = 'settings';
let tray = null;
let settings = null;
let settingsPath = null;
let logPath = null;
let client = null;
let updateTimer = null;
let updateState = {
  checking: false,
  available: false,
  skipped: false,
  downloading: false,
  ready: false,
  installing: false,
  progress: 0,
  current: app.getVersion(),
  latest: '',
  releaseUrl: '',
  notes: '',
  error: '',
  checkedAt: 0,
};
let lastTrace = null;
let usageData = null;
let usageStatus = { loading: false, stale: false, at: 0, error: '', period: '' };
let usageRequest = null;
let usageTimer = null;
let connection = { online: false, detail: '正在连接' };
let layoutMode = false;
let layoutTimer = null;
let hoverInteractive = false;
let hoverKind = null;
// The renderer measures the controls and drag strip after scaling. Only
// these regions and the resize border take a pointer while no panel is open.
let hitAreas = { controls: [], dragTop: 12, dragBottom: 46 };
let dragState = null;
let resizeState = null;
let hoverTimer = null;
let quitting = false;
let positionTimer = null;
let aliveTimer = null;
let pauseTimer = null;
let frame = { lanes: 1, cardHeight: 400, windowHeight: 432 };

function log(message) {
  try {
    fs.appendFileSync(logPath, `${new Date().toISOString()}  ${message}\n`);
  } catch {
    // Logging must never take the widget down.
  }
}

// The plugin reads this to tell a hidden card from a quit one, and to know
// whether the user wants it started again.
function touchAlive(stopped = false) {
  try {
    fs.writeFileSync(
      path.join(app.getPath('userData'), 'alive'),
      JSON.stringify(heartbeat(settings, Date.now(), stopped)),
    );
    return true;
  } catch {
    // A heartbeat is best effort; it never stops the widget.
    return false;
  }
}
function defaults() {
  return {
    topmost: true,
    maskAccounts: true,
    opacity: 1.0,
    left: null,
    top: null,
    width: WIDTH,
    height: HEIGHT,
    gateway: null,
    checkUpdates: true,
    updateMode: 'idle',
    skippedUpdate: '',
    usagePeriod: '30d',
    enabledPeriods: [...USAGE_PERIODS],
    pillMetric: 'total',
    rollTokens: true,
    showQuota: true,
    showTiming: true,
    hubEffect: 'ripple',
    keepAlive: true,
    pauseUntil: 0,
    hotkey: 'Control+Alt+M',
    hotkeyOn: true,
    autostart: false,
  };
}

// The four windows magpie's /v1/magpie/usage answers, in the order a click
// on the token pill walks them.
const USAGE_PERIODS = ['today', '7d', '30d', 'all'];

// What the pill's number counts.
const PILL_METRICS = ['total', 'input', 'output', 'cache'];

function normalizePeriod(value) {
  const period = String(value || '').toLowerCase();
  return USAGE_PERIODS.includes(period) ? period : '30d';
}

// The windows the pill may cycle through: at least one, in canonical order.
function normalizePeriods(value) {
  const wanted = Array.isArray(value) ? value.map((item) => String(item).toLowerCase()) : [];
  const kept = USAGE_PERIODS.filter((period) => wanted.includes(period));
  return kept.length ? kept : [...USAGE_PERIODS];
}

function normalizeMetric(value) {
  const metric = String(value || '').toLowerCase();
  return PILL_METRICS.includes(metric) ? metric : 'total';
}

// How the card answers a request crossing magpie: the staged effects the
// preview page showed, plus 无 to switch the gesture off entirely. Ripple
// stays the default because it is the quietest.
const HUB_EFFECTS = ['none', 'ripple', 'vortex', 'dissolve', 'arc'];

function normalizeHubEffect(value) {
  const effect = String(value || '').toLowerCase();
  return HUB_EFFECTS.includes(effect) ? effect : 'ripple';
}

// How the desktop app takes a newer release: on idle, only after the user
// asks, or not at all.
const UPDATE_MODES = ['idle', 'notice', 'never'];

function normalizeUpdateMode(value) {
  const mode = String(value || '').toLowerCase();
  return UPDATE_MODES.includes(mode) ? mode : 'idle';
}
// A stored size is snapped back to the card's shape, within the allowed
// range, so a window saved before the shape was enforced still fits.
function normalizeSize(width) {
  let w = Math.max(600, Math.min(1600, Number(width) || WIDTH));
  let h = heightForWidth(w);
  if (h > 1200) {
    h = 1200;
    w = Math.max(600, Math.min(1600, widthForHeight(h)));
  }
  if (h < 432) {
    h = 432;
    w = Math.max(600, Math.min(1600, widthForHeight(h)));
  }
  return { width: w, height: h };
}

function loadSettings() {
  try {
    const raw = fs.readFileSync(settingsPath, 'utf8');
    const parsed = JSON.parse(raw);
    const enabledPeriods = normalizePeriods(parsed.enabledPeriods);
    const usagePeriod = normalizePeriod(parsed.usagePeriod);
    const size = normalizeSize(parsed.width);
    return {
      ...defaults(),
      ...parsed,
      opacity: Math.min(1, Math.max(0.4, Number(parsed.opacity) || 1)),
      width: size.width,
      height: size.height,
      usagePeriod: enabledPeriods.includes(usagePeriod) ? usagePeriod : enabledPeriods[0],
      enabledPeriods,
      pillMetric: normalizeMetric(parsed.pillMetric),
      rollTokens: parsed.rollTokens !== false,
      showQuota: parsed.showQuota !== false,
      showTiming: parsed.showTiming !== false,
      hubEffect: normalizeHubEffect(parsed.hubEffect),
      keepAlive: parsed.keepAlive !== false,
      hotkey: String(parsed.hotkey || DEFAULT_HOTKEY).trim(),
      hotkeyOn: parsed.hotkeyOn !== false,
      autostart: parsed.autostart === true,
      // An old install only had the on/off check: it means `never'' now.
      updateMode: normalizeUpdateMode(parsed.updateMode ?? (parsed.checkUpdates === false ? 'never' : 'idle')),
      checkUpdates: normalizeUpdateMode(parsed.updateMode ?? (parsed.checkUpdates === false ? 'never' : 'idle')) !== 'never',
    };
  } catch {
    return defaults();
  }
}

function saveSettings(next = settings) {
  const temporary = `${settingsPath}.tmp`;
  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify(next, null, 2), 'utf8');
    fs.renameSync(temporary, settingsPath);
    return { ok: true };
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch { /* keep the original settings */ }
    log(`save settings: ${error.message}`);
    return { ok: false, error: `保存失败：${error.message}` };
  }
}

function readMagpiePort() {
  try {
    const file = path.join(os.homedir(), '.config', 'magpie', 'settings.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const port = Number(parsed.port);
    if (Number.isInteger(port) && port > 0 && port < 65536) return port;
  } catch {
    // magpie has never been run, or has no custom port.
  }
  return 3425;
}

function normalizeGateway(raw) {
  let value = String(raw || '').trim();
  if (!value.includes('://')) value = `http://${value}`;
  let url;
  try {
    url = new URL(value);
  } catch {
    return 'http://127.0.0.1:3425';
  }
  let host = url.hostname;
  if (!host || host === '0.0.0.0' || host === '::' || host === '[::]' || host === 'localhost') {
    host = '127.0.0.1';
  }
  const port = url.port || '3425';
  return `http://${host}:${port}`;
}

function resolveGateway() {
  if (settings.gateway) return normalizeGateway(settings.gateway);
  const env = process.env.BUSY_MAGPIE_GATEWAY || process.env.MAGPIE_ADDR;
  if (env) return normalizeGateway(env);
  return `http://127.0.0.1:${readMagpiePort()}`;
}

function displayAddress(base) {
  return base.replace(/^https?:\/\//i, '').replace(/\/$/, '');
}

function defaultBounds(width = WIDTH, height = HEIGHT) {
  const area = screen.getPrimaryDisplay().workArea;
  return {
    x: Math.round(area.x + area.width - width - 22),
    y: Math.round(area.y + area.height - height - 18),
  };
}

function clampBounds(x, y, width = WIDTH, height = HEIGHT) {
  const display = screen.getDisplayNearestPoint({ x, y });
  const area = display.workArea;
  const maxX = area.x + area.width - width;
  const maxY = area.y + area.height - height;
  return {
    x: Math.min(Math.max(Math.round(x), area.x), maxX),
    y: Math.min(Math.max(Math.round(y), area.y), maxY),
  };
}

function createWindow() {
  const area = screen.getPrimaryDisplay().workArea;
  let width = Math.max(600, Math.min(settings.width || WIDTH, area.width - 20));
  let height = heightForWidth(width);
  const maxHeight = Math.min(area.height - 20, 1200);
  if (height > maxHeight) {
    height = Math.max(432, maxHeight);
    width = Math.max(600, Math.min(area.width - 20, widthForHeight(height)));
    height = heightForWidth(width);
  }
  settings.width = width;
  settings.height = height;
  const fallback = defaultBounds(width, height);
  const x = Number.isFinite(settings.left) ? settings.left : fallback.x;
  const y = Number.isFinite(settings.top) ? settings.top : fallback.y;
  const bounds = clampBounds(x, y, width, height);
  settings.left = bounds.x;
  settings.top = bounds.y;

  win = new BrowserWindow({
    width,
    height,
    x: bounds.x,
    y: bounds.y,
    transparent: true,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    show: false,
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: settings.topmost,
    backgroundColor: '#00000000',
    roundedCorners: false,
    acceptFirstMouse: true,
    title: 'Busy Magpie',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  win.setMenuBarVisibility(false);
  if (IS_MAC) {
    win.setWindowButtonVisibility?.(false);
    win.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: false,
      skipTransformProcessType: true,
    });
    win.setHiddenInMissionControl?.(true);
  }

  applyTopmost();
  applyClickThrough();
  win.setOpacity(settings.opacity);
  win.loadFile(RENDERER);

  win.once('ready-to-show', () => {
    if (Number(settings.pauseUntil) > Date.now()) return;
    win.showInactive();
    applyClickThrough();
    applyTopmost();
    if (firstRunOpen) win.focus();
  });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  win.webContents.on('before-input-event', (event, input) => {
    if ((firstRunOpen || settingsOpen || quickMenuOpen || layoutMode || dragState || resizeState)
      && input.type === 'keyDown' && input.key === 'Escape') {
      if (firstRunOpen) {
        firstRunOpen = false;
        applyClickThrough();
        send('magpie:first-run', false);
      } else if (settingsOpen) closeSettingsPanel();
      else if (quickMenuOpen) setQuickMenuOpen(false);
      else if (resizeState) endResize();
      else if (dragState) endDrag();
      else endLayout();
      event.preventDefault();
    }
  });

  win.on('moved', () => {
    clearTimeout(positionTimer);
    positionTimer = setTimeout(savePosition, 350);
  });

  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
    refreshTrayMenu();
  });

  win.on('show', () => refreshTrayMenu());
  win.on('hide', () => {
    setQuickMenuOpen(false);
    if (settingsOpen) closeSettingsPanel();
    hoverInteractive = false;
    hoverKind = null;
    refreshTrayMenu();
  });
  win.on('blur', () => setQuickMenuOpen(false));

  win.webContents.on('did-start-loading', () => {
    rendererReady = false;
    setQuickMenuOpen(false);
  });
  win.webContents.on('did-finish-load', () => {
    win.webContents.send('magpie:settings', publicSettings());
    win.webContents.send('magpie:frame', frame);
    if (lastTrace) win.webContents.send('magpie:trace', lastTrace);
    win.webContents.send('magpie:connection', connection);
    win.webContents.send('magpie:layout', layoutMode);
    if (settingsOpen) {
      win.webContents.send('magpie:settings-panel', { open: true, mode: currentPanelMode });
    }
  });
}

function publicSettings() {
  return {
    maskAccounts: settings.maskAccounts,
    topmost: settings.topmost,
    opacity: settings.opacity,
    gateway: displayAddress(resolveGateway()),
    keepAlive: settings.keepAlive !== false,
    updateMode: settings.updateMode,
    usagePeriod: settings.usagePeriod,
    enabledPeriods: settings.enabledPeriods,
    pillMetric: settings.pillMetric,
    rollTokens: settings.rollTokens !== false,
    showQuota: settings.showQuota !== false,
    showTiming: settings.showTiming !== false,
    hubEffect: settings.hubEffect,
  };
}

function compareVersions(a, b) {
  const left = String(a || '').replace(/^v/i, '').split(/[.+-]/).map((part) => Number(part) || 0);
  const right = String(b || '').replace(/^v/i, '').split(/[.+-]/).map((part) => Number(part) || 0);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const delta = (left[i] || 0) - (right[i] || 0);
    if (delta !== 0) return delta < 0 ? -1 : 1;
  }
  return 0;
}

function updateView() {
  return {
    ...updateState,
    current: app.getVersion(),
    pluginVersion: PLUGIN_VERSION,
    auto: settings.checkUpdates !== false,
  };
}

function sendUpdateState() {
  send('magpie:update-state', updateView());
}

function refreshUpdateAvailability() {
  updateState.current = app.getVersion();
  updateState.available = Boolean(
    updateState.latest && compareVersions(updateState.current, updateState.latest) < 0,
  );
  updateState.skipped = Boolean(
    updateState.latest && settings.skippedUpdate === updateState.latest,
  );
}

// ── updates ───────────────────────────────────────────────────────────────
//
// electron-updater owns the download and the installer: it checks the sha512
// from the release feed, fetches only the changed blocks when it has a block
// map, runs the NSIS installer once the card has quit and starts it again.
// Ours stays the when and the whether: the update mode, the skipped version,
// the hourly look, the idle moment to install, and the one thing the library
// cannot know — the launcher plugin starts the card again when its heartbeat
// goes stale, so an install in progress has to leave a marker.

const QUIET_BEFORE_INSTALL_MS = 5 * 60 * 1000;
let lastActivity = Date.now();
let quietTimer = null;
let lastNotifiedUpdate = '';

// A request through the gateway is a sign someone is looking.
function markActivity() {
  lastActivity = Date.now();
}

function updatingMarker() {
  return path.join(app.getPath('userData'), 'updating');
}

function writeUpdatingMarker() {
  try {
    fs.writeFileSync(updatingMarker(), JSON.stringify({ at: Date.now() }));
  } catch {
    // The marker is a courtesy to the launcher, never a reason to fail.
  }
}

function clearUpdatingMarker() {
  try { fs.rmSync(updatingMarker(), { force: true }); } catch { /* ignore */ }
}

function releaseNotesOf(info) {
  const notes = info && info.releaseNotes;
  if (typeof notes === 'string') return notes;
  if (Array.isArray(notes)) {
    return notes.map((item) => String((item && item.note) || '')).join('\n\n');
  }
  return '';
}

function setupUpdater() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = false;

  autoUpdater.on('checking-for-update', () => {
    updateState.checking = true;
    updateState.error = '';
    sendUpdateState();
  });

  autoUpdater.on('update-available', (info) => {
    updateState.checking = false;
    updateState.checkedAt = Date.now();
    updateState.latest = String((info && info.version) || '').replace(/^v/i, '');
    updateState.notes = releaseNotesOf(info);
    updateState.releaseUrl = updateState.latest
      ? `https://github.com/yimi1mi/busy-magpie/releases/tag/v${updateState.latest}`
      : '';
    refreshUpdateAvailability();
    sendUpdateState();
    const mode = normalizeUpdateMode(settings.updateMode);
    if (updateState.available && !updateState.skipped && !updateState.downloading) {
      if (mode === 'idle') downloadUpdate();
      if (mode === 'notice' && lastNotifiedUpdate !== updateState.latest) {
        lastNotifiedUpdate = updateState.latest;
        notifyUpdate();
      }
    }
  });

  autoUpdater.on('update-not-available', (info) => {
    updateState.checking = false;
    updateState.checkedAt = Date.now();
    updateState.latest = String((info && info.version) || app.getVersion()).replace(/^v/i, '');
    updateState.available = false;
    updateState.skipped = false;
    updateState.ready = false;
    updateState.downloading = false;
    updateState.progress = 0;
    sendUpdateState();
  });

  autoUpdater.on('download-progress', (progress) => {
    updateState.downloading = true;
    updateState.installing = false;
    updateState.progress = Math.max(0, Math.min(1, Number(progress && progress.percent) / 100 || 0));
    sendUpdateState();
  });

  autoUpdater.on('update-downloaded', () => {
    updateState.downloading = false;
    updateState.ready = true;
    updateState.progress = 1;
    sendUpdateState();
    scheduleQuietInstall();
  });

  autoUpdater.on('error', (error) => {
    updateState.checking = false;
    updateState.downloading = false;
    updateState.installing = false;
    updateState.error = (error && error.message) || '更新失败';
    log(`update: ${updateState.error}`);
    sendUpdateState();
  });
}

function notifyUpdate() {
  if (!Notification.isSupported()) return;
  try {
    new Notification({
      title: 'Busy Magpie',
      body: `v${updateState.latest} 可用，点卡片右上角版本号更新`,
    }).show();
  } catch {
    // Notifications can be unavailable on locked-down systems.
  }
}

async function checkForUpdates(manual = false) {
  if (updateState.checking) return updateView();
  if (!manual && normalizeUpdateMode(settings.updateMode) === 'never') return updateView();
  if (!app.isPackaged) {
    // A dev run has no release feed of its own: say it is current instead of
    // failing through the updater.
    updateState.checkedAt = Date.now();
    updateState.latest = app.getVersion();
    updateState.available = false;
    updateState.error = '';
    sendUpdateState();
    return updateView();
  }
  updateState.checking = true;
  updateState.error = '';
  sendUpdateState();
  try {
    const result = await autoUpdater.checkForUpdates();
    if (result && result.updateInfo) {
      updateState.latest = String(result.updateInfo.version || '').replace(/^v/i, '');
      refreshUpdateAvailability();
    }
  } catch (error) {
    updateState.error = (error && error.message) || '检查更新失败';
    log(`update check: ${updateState.error}`);
  } finally {
    updateState.checking = false;
    sendUpdateState();
  }
  return updateView();
}

async function downloadUpdate() {
  if (!app.isPackaged || updateState.downloading || updateState.ready) return;
  if (updateState.skipped) return;
  try {
    updateState.downloading = true;
    updateState.error = '';
    sendUpdateState();
    await autoUpdater.downloadUpdate();
  } catch (error) {
    updateState.downloading = false;
    updateState.error = (error && error.message) || '下载更新失败';
    log(`update download: ${updateState.error}`);
    sendUpdateState();
  }
}

// "空闲" lets the card restart itself, but not over a look: wait until
// nothing has gone through the gateway for five minutes.
function scheduleQuietInstall() {
  clearInterval(quietTimer);
  quietTimer = null;
  if (normalizeUpdateMode(settings.updateMode) !== 'idle') return;
  quietTimer = setInterval(() => {
    if (!updateState.ready || quitting) return;
    if (normalizeUpdateMode(settings.updateMode) !== 'idle') return;
    if (activeCount(lastTrace?.routes) > 0) return;
    if (firstRunOpen || settingsOpen || settingsClosing || quickMenuOpen || layoutMode || dragState || resizeState) return;
    if (Date.now() - lastActivity < QUIET_BEFORE_INSTALL_MS) return;
    clearInterval(quietTimer);
    quietTimer = null;
    log(`update: quiet for five minutes, installing ${updateState.latest}`);
    installUpdate();
  }, 60 * 1000);
}

async function installUpdate() {
  if (!app.isPackaged) return updateView();
  if (updateState.installing) return updateView();
  if (process.platform !== 'win32') {
    // An unsigned mac app cannot replace itself; the release page is honest.
    if (updateState.releaseUrl) shell.openExternal(updateState.releaseUrl);
    return updateView();
  }
  if (!updateState.ready) {
    await downloadUpdate();
    if (!updateState.ready) return updateView();
  }
  try {
    updateState.installing = true;
    updateState.downloading = false;
    updateState.error = '';
    sendUpdateState();
    clearInterval(quietTimer);
    quietTimer = null;
    writeUpdatingMarker();
    log(`update: installing ${updateState.latest}`);
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
  } catch (error) {
    updateState.installing = false;
    updateState.error = (error && error.message) || '更新失败';
    log(`update install: ${updateState.error}`);
    sendUpdateState();
  }
  return updateView();
}

function skipUpdate() {
  if (!updateState.latest) return updateView();
  settings.skippedUpdate = updateState.latest;
  saveSettings();
  refreshUpdateAvailability();
  sendUpdateState();
  return updateView();
}

function setCheckUpdates(value) {
  settings.checkUpdates = Boolean(value);
  settings.updateMode = settings.checkUpdates ? 'notice' : 'never';
  saveSettings();
  sendUpdateState();
  if (settings.checkUpdates) checkForUpdates(false);
  return updateView();
}

function savePosition() {
  if (!win || win.isDestroyed()) return;
  const [x, y] = win.getPosition();
  settings.left = x;
  settings.top = y;
  saveSettings();
}

function applyTopmost() {
  if (!win || win.isDestroyed()) return;
  win.setAlwaysOnTop(settings.topmost, IS_MAC ? 'floating' : 'normal');
}

function applyClickThrough() {
  if (!win || win.isDestroyed()) return;
  if (firstRunOpen || settingsOpen || settingsClosing || quickMenuOpen || layoutMode || hoverInteractive) {
    win.setIgnoreMouseEvents(false);
    win.setFocusable(true);
  } else {
    win.setIgnoreMouseEvents(true, { forward: true });
    win.setFocusable(false);
  }
}

function showWindow() {
  if (!win || win.isDestroyed()) return;
  if (settings.pauseUntil) {
    settings.pauseUntil = 0;
    clearTimeout(pauseTimer);
    saveSettings();
    touchAlive();
  }
  if (!win.isVisible()) win.showInactive();
  applyClickThrough();
  applyTopmost();
  refreshTrayMenu();
}

function schedulePauseResume() {
  clearTimeout(pauseTimer);
  const remaining = Number(settings.pauseUntil) - Date.now();
  if (remaining <= 0) return;
  pauseTimer = setTimeout(() => showWindow(), Math.min(remaining, 2_147_483_647));
}

function pauseDisplay() {
  const next = { ...settings, pauseUntil: Date.now() + 60 * 60 * 1000 };
  const saved = saveSettings(next);
  if (!saved.ok) {
    send('magpie:action-error', saved.error);
    return;
  }
  settings = next;
  touchAlive();
  win.hide();
  schedulePauseResume();
  refreshTrayMenu();
}

function setQuickMenuOpen(value) {
  if (!win || win.isDestroyed()) return;
  const open = Boolean(value);
  if (open && (!win.isVisible() || firstRunOpen || settingsOpen || settingsClosing
    || layoutMode || dragState || resizeState)) return;
  if (quickMenuOpen === open) return;
  quickMenuOpen = open;
  setHoverInteractive(false);
  applyClickThrough();
  send('magpie:quick-menu', open);
  if (open) win.focus();
}

function openSettingsPanel(mode = 'settings') {
  if (!win || win.isDestroyed()) return;
  setQuickMenuOpen(false);
  if (!rendererReady) {
    pendingSettings = true;
    pendingPanelMode = mode;
    return;
  }
  if (settingsOpen || settingsClosing) {
    if (settingsOpen && mode !== currentPanelMode) {
      currentPanelMode = mode;
      send('magpie:settings-panel', { open: true, mode });
    }
    win.showInactive();
    win.focus();
    return;
  }
  if (!win.isVisible()) win.showInactive();

  settingsOpen = true;
  settingsClosing = false;
  currentPanelMode = mode;
  hoverInteractive = false;
  win.setIgnoreMouseEvents(false);
  win.setFocusable(true);
  win.focus();
  // The panel covers the card; the window itself never changes size.
  send('magpie:settings-panel', { open: true, mode });
  refreshTrayMenu();
}

function closeSettingsPanel() {
  if (!settingsOpen || settingsClosing) return;
  settingsClosing = true;
  settingsOpen = false;
  currentPanelMode = 'settings';
  if (resizeState) {
    clearInterval(resizeState.timer);
    clearTimeout(resizeState.max);
    resizeState = null;
  }
  send('magpie:settings-panel', { open: false });
  // Let the panel's fade finish before the card takes the pointer again.
  setTimeout(() => {
    if (win && !win.isDestroyed()) {
      win.setIgnoreMouseEvents(true, { forward: true });
      win.setFocusable(false);
      win.blur();
      applyTopmost();
    }
    settingsClosing = false;
    hoverInteractive = false;
    hoverKind = null;
    refreshTrayMenu();
  }, 180);
}

// Closing the card only hides it, and on Windows the tray icon often sits in
// the overflow flyout, so there has to be one way back that is always there:
// a global shortcut that shows or hides the card from anywhere.
const DEFAULT_HOTKEY = 'Control+Alt+M';
let hotkeyOk = false;

function displayHotkey() {
  return String(settings.hotkey || DEFAULT_HOTKEY)
    .replace(/CommandOrControl/g, IS_MAC ? 'Cmd' : 'Ctrl')
    .replace(/Control/g, 'Ctrl')
    .replace(/\+/g, '+');
}

function registerHotkey() {
  globalShortcut.unregisterAll();
  hotkeyOk = false;
  const accelerator = String(settings.hotkey || DEFAULT_HOTKEY).trim();
  if (settings.hotkeyOn === false || !accelerator) return;
  try {
    hotkeyOk = globalShortcut.register(accelerator, () => toggleVisible());
  } catch (error) {
    hotkeyOk = false;
    log(`hotkey ${accelerator} not registered: ${error.message}`);
  }
  if (!hotkeyOk) log(`hotkey ${accelerator} is taken or invalid`);
}

function toggleVisible() {
  if (!win || win.isDestroyed()) return;
  if (win.isVisible()) {
    win.hide();
  } else {
    showWindow();
  }
}

function setHoverInteractive(value, kind = null) {
  if (!win || win.isDestroyed()) return;
  if (hoverInteractive === value && hoverKind === kind) return;
  hoverInteractive = value;
  hoverKind = value ? kind : null;
  applyClickThrough();
  send('magpie:grab', hoverKind === 'drag');
  send('magpie:resize', hoverKind === 'resize');
}

// Only the top strip is allowed to catch the pointer while the card is
// otherwise click-through. Hovering it wakes the strip up; the renderer
// then turns a long press into a manual drag.
function watchHover() {
  clearInterval(hoverTimer);
  hoverTimer = setInterval(() => {
    if (!win || win.isDestroyed() || !win.isVisible() || firstRunOpen || settingsOpen || settingsClosing || quickMenuOpen || layoutMode || dragState || resizeState) return;
    const point = screen.getCursorScreenPoint();
    const bounds = win.getBounds();
    const card = {
      left: bounds.x + 16,
      right: bounds.x + bounds.width - 16,
      top: bounds.y + 16,
      bottom: bounds.y + bounds.height - 16,
    };
    const edge = 8;
    const north = point.y >= card.top && point.y <= card.top + edge;
    const south = point.y >= card.bottom - edge && point.y <= card.bottom;
    const west = point.x >= card.left && point.x <= card.left + edge;
    const east = point.x >= card.right - edge && point.x <= card.right;
    const within = point.x >= card.left && point.x <= card.right
      && point.y >= card.top && point.y <= card.bottom;
    const onBorder = within && (north || south || west || east);
    const onTopBar = point.x >= bounds.x
      && point.x <= bounds.x + bounds.width
      && point.y >= bounds.y + hitAreas.dragTop
      && point.y <= bounds.y + hitAreas.dragBottom;
    // Controls take priority over dragging or resizing where they overlap.
    const onControl = hitAreas.controls.some((rect) => (
      point.x >= bounds.x + rect.x && point.x <= bounds.x + rect.x + rect.width
      && point.y >= bounds.y + rect.y && point.y <= bounds.y + rect.y + rect.height
    ));
    const kind = onControl ? 'control' : onBorder ? 'resize' : onTopBar ? 'drag' : null;
    setHoverInteractive(Boolean(kind), kind);
  }, 70);
}

function setHitAreas(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const controls = (Array.isArray(source.controls) ? source.controls : []).flatMap((rect) => {
    if (!rect || typeof rect !== 'object') return [];
    const numbers = ['x', 'y', 'width', 'height'].map((key) => Number(rect[key]));
    if (!numbers.every(Number.isFinite) || numbers[2] <= 0 || numbers[3] <= 0) return [];
    return [{ x: numbers[0], y: numbers[1], width: numbers[2], height: numbers[3] }];
  });
  const top = Number(source.dragTop);
  const bottom = Number(source.dragBottom);
  hitAreas = {
    controls,
    dragTop: Number.isFinite(top) ? top : 12,
    dragBottom: Number.isFinite(bottom) && Number.isFinite(top) && bottom > top
      ? bottom
      : 46,
  };
}

function startDrag() {
  if (!win || win.isDestroyed() || firstRunOpen || settingsOpen || settingsClosing || quickMenuOpen || dragState) return;
  const point = screen.getCursorScreenPoint();
  const [x, y] = win.getPosition();
  hoverInteractive = false;
  win.setIgnoreMouseEvents(false);
  win.setFocusable(true);
  win.focus();
  const state = {
    pointerX: point.x,
    pointerY: point.y,
    windowX: x,
    windowY: y,
    timer: null,
    max: null,
  };
  state.timer = setInterval(() => {
    if (!win || win.isDestroyed()) {
      endDrag();
      return;
    }
    const now = screen.getCursorScreenPoint();
    win.setPosition(
      Math.round(state.windowX + now.x - state.pointerX),
      Math.round(state.windowY + now.y - state.pointerY),
    );
  }, 16);
  state.max = setTimeout(endDrag, 15000);
  dragState = state;
  send('magpie:grab', true);
}

function endDrag() {
  if (!dragState) return;
  clearInterval(dragState.timer);
  clearTimeout(dragState.max);
  dragState = null;
  savePosition();
  hoverInteractive = false;
  if (win && !win.isDestroyed()) {
    win.setIgnoreMouseEvents(true, { forward: true });
    win.setFocusable(false);
    win.blur();
    applyTopmost();
    send('magpie:grab', false);
  }
  refreshTrayMenu();
}

function startResize(direction = 'se') {
  if (!win || win.isDestroyed() || firstRunOpen || settingsClosing || quickMenuOpen || resizeState) return;
  const dir = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].includes(direction)
    ? direction
    : 'se';
  const point = screen.getCursorScreenPoint();
  const bounds = win.getBounds();
  const display = screen.getDisplayNearestPoint(point);
  const area = display.workArea;
  hoverInteractive = false;
  win.setIgnoreMouseEvents(false);
  win.setFocusable(true);
  win.focus();
  const state = {
    direction: dir,
    pointerX: point.x,
    pointerY: point.y,
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    minWidth: 600,
    minHeight: 432,
    timer: null,
    max: null,
  };
  state.maxW = dir.includes('e')
    ? Math.max(bounds.width, area.x + area.width - bounds.x - 8)
    : Math.max(bounds.width, bounds.x + bounds.width - area.x - 8);
  state.maxH = dir.includes('s')
    ? Math.max(bounds.height, area.y + area.height - bounds.y - 8)
    : Math.max(bounds.height, bounds.y + bounds.height - area.y - 8);

  state.timer = setInterval(() => {
    if (!win || win.isDestroyed()) {
      endResize();
      return;
    }
    const now = screen.getCursorScreenPoint();
    const dx = now.x - state.pointerX;
    const dy = now.y - state.pointerY;

    let width = state.width;
    let height = state.height;
    let x = state.x;
    let y = state.y;

    if (dir.includes('e')) {
      width = Math.max(state.minWidth, Math.min(state.maxW, state.width + dx));
    } else if (dir.includes('w')) {
      width = Math.max(state.minWidth, Math.min(state.maxW, state.width - dx));
    }
    if (dir.includes('s')) {
      height = Math.max(state.minHeight, Math.min(state.maxH, height + dy));
    } else if (dir.includes('n')) {
      height = Math.max(state.minHeight, Math.min(state.maxH, height - dy));
    }

    // The card keeps its shape, so the scaled canvas always fills it: a
    // horizontal drag sets the width and the height follows, and the other
    // way round for a vertical edge.
    if (dir.includes('e') || dir.includes('w')) {
      height = heightForWidth(width);
      if (height > state.maxH) {
        height = state.maxH;
        width = widthForHeight(height);
      } else if (height < state.minHeight) {
        height = state.minHeight;
        width = widthForHeight(height);
      }
    } else {
      width = widthForHeight(height);
      if (width > state.maxW) {
        width = state.maxW;
        height = heightForWidth(width);
      } else if (width < state.minWidth) {
        width = state.minWidth;
        height = heightForWidth(width);
      }
    }
    width = Math.max(state.minWidth, Math.min(state.maxW, width));
    height = Math.max(state.minHeight, Math.min(state.maxH, height));
    if (dir.includes('w')) x = state.x + state.width - width;
    if (dir.includes('n')) y = state.y + state.height - height;

    win.setBounds({ x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) }, false);
    settings.left = Math.round(x);
    settings.top = Math.round(y);
    settings.width = Math.round(width);
    settings.height = Math.round(height);
  }, 16);
  state.max = setTimeout(endResize, 15000);
  resizeState = state;
  send('magpie:resize', true);
}

function endResize() {
  if (!resizeState) return;
  clearInterval(resizeState.timer);
  clearTimeout(resizeState.max);
  resizeState = null;
  saveSettings();
  if (win && !win.isDestroyed()) {
    // The drawer leaves the window interactive; the bare card does not.
    if (!settingsOpen) {
      win.setIgnoreMouseEvents(true, { forward: true });
      win.setFocusable(false);
      win.blur();
    }
    applyTopmost();
    const bounds = win.getBounds();
    // settings.height is always the card's height, pane excluded, so this
    // holds whether or not the drawer is open — and whether it closed in
    // the middle of the drag.
    const cardHeight = Math.max(432, Number(settings.height) || bounds.height);
    frame = { lanes: frame.lanes, cardHeight: cardHeight - 32, windowHeight: bounds.height };
    send('magpie:frame', frame);
    send('magpie:resize', false);
  }
  refreshTrayMenu();
}

function beginLayout() {
  if (!win || win.isDestroyed() || firstRunOpen || settingsOpen || settingsClosing || layoutMode) return;
  setQuickMenuOpen(false);
  layoutMode = true;
  if (!win.isVisible()) win.showInactive();
  win.setIgnoreMouseEvents(false);
  win.setFocusable(true);
  win.setAlwaysOnTop(true, IS_MAC ? 'floating' : 'normal');
  if (IS_MAC) app.focus({ steal: true });
  win.focus();
  win.webContents.send('magpie:layout', true);
  send('magpie:grab', true);
  clearTimeout(layoutTimer);
  layoutTimer = setTimeout(endLayout, 30000);
}

function endLayout() {
  if (!layoutMode) return;
  layoutMode = false;
  hoverInteractive = false;
  hoverKind = null;
  clearTimeout(layoutTimer);
  layoutTimer = null;
  savePosition();
  if (win && !win.isDestroyed()) {
    win.webContents.send('magpie:layout', false);
    win.setIgnoreMouseEvents(true, { forward: true });
    win.setFocusable(false);
    win.blur();
    applyTopmost();
    send('magpie:grab', false);
  }
  refreshTrayMenu();
}

function activeCount(routes) {
  return (Array.isArray(routes) ? routes : []).filter((route) => (
    !route.done || (Array.isArray(route.tries) && route.tries.some((tryItem) => !tryItem.done))
  )).length;
}

function fitWindow(lanes) {
  // Agent count never resizes the window. Only the user's resize handle can.
  if (!win || win.isDestroyed()) return;
  const bounds = win.getBounds();
  frame = { lanes, cardHeight: bounds.height - 32, windowHeight: bounds.height };
  send('magpie:frame', frame);
}

function rebuildClient() {
  if (client) client.stop();
  client = new TraceClient(resolveGateway());
  client.start();
  refreshUsage(normalizePeriod(settings.usagePeriod));
}

async function refreshUsage(requestedPeriod) {
  if (requestedPeriod === undefined && usageRequest) return usageRequest.promise;
  const period = normalizePeriod(requestedPeriod ?? settings.usagePeriod);
  if (usageRequest) usageRequest.controller.abort();
  const controller = new AbortController();
  const request = { controller, promise: null };
  usageRequest = request;
  usageStatus = { ...usageStatus, loading: true, error: '', period };
  send('magpie:usage-status', usageStatus);
  request.promise = readUsage();
  return request.promise;

  async function readUsage() {
    const timeout = setTimeout(() => controller.abort(), 6000);
    try {
      const response = await fetch(`${resolveGateway()}/v1/magpie/usage?period=${period}`, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });
      if (!response.ok) {
        throw new Error(`用量接口返回 HTTP ${response.status}`);
      }
      const data = await response.json();
      if (usageRequest !== request) return null;
      if (!data || typeof data !== 'object' || !['input', 'output', 'cache_read', 'cache_write'].some(key => key in data)) {
        throw new Error('用量接口未返回统计数据');
      }
      usageData = { ...data, period };
      usageStatus = { loading: false, stale: false, at: Date.now(), error: '', period };
      send('magpie:usage', usageData);
      send('magpie:usage-status', usageStatus);
      return usageData;
    } catch (error) {
      if (usageRequest !== request) return null;
      const detail = error.name === 'AbortError' ? '读取用量超时' : error.message;
      usageStatus = { ...usageStatus, loading: false, stale: Boolean(usageData), error: detail, period };
      log(`usage unavailable: ${detail}`);
      send('magpie:usage-status', usageStatus);
      return null;
    } finally {
      clearTimeout(timeout);
      if (usageRequest === request) usageRequest = null;
    }
  }
}

// The renderer's click on the token pill asks for the next window. The
// answer carries the fresh summary so the pill can repaint at once instead
// of waiting for the next poll. A failed fetch keeps the window on file:
// the next poll retries it, and the pill still shows the old summary.
async function setUsagePeriod(value) {
  const period = normalizePeriod(value);
  // A period the user switched off is not one the pill may cycle to.
  if (!settings.enabledPeriods.includes(period)) {
    return { period: settings.usagePeriod, usage: usageData };
  }
  const usage = await refreshUsage(period);
  if (!usage) return { ok: false, period: settings.usagePeriod, error: usageStatus.error };
  if (period !== settings.usagePeriod) {
    settings.usagePeriod = period;
    const saved = saveSettings();
    if (!saved.ok) {
      usageStatus = { ...usageStatus, error: '数据已切换，但时间窗未能保存' };
      send('magpie:usage-status', usageStatus);
    }
  }
  send('magpie:settings', publicSettings());
  return { ok: true, period, usage };
}

class TraceClient {
  constructor(base) {
    this.base = base;
    this.seq = 0;
    this.first = true;
    this.stopped = false;
    this.controller = null;
    this.lastError = '';
    // Failed reads in a row: they decide how long the next retry waits.
    this.misses = 0;
    // The gateway's pid: a different one is a magpie that started again, so
    // its sequence and routes are not the ones this client remembers.
    this.pid = 0;
    // The last time the loop did anything at all. The watchdog reads it to
    // tell a retrying loop from one that stopped without saying so.
    this.lastBeat = Date.now();
    // The endpoint after a non-zero seq returns only changed routes, not a
    // full snapshot. Keep the union so a request that started earlier stays
    // on the card until it is done.
    this.routes = new Map();
  }

  start() {
    this.stopped = false;
    this.lastBeat = Date.now();
    // The loop itself retries every failure, but a fault outside the try (a
    // throw from the renderer bridge, a rejected promise nobody awaited) used
    // to end it for good. Nothing below the watchdog depends on it surviving.
    this.loop().catch((error) => {
      log(`trace loop stopped: ${error && error.stack ? error.stack : error}`);
    });
  }

  stop() {
    this.stopped = true;
    if (this.controller) this.controller.abort();
  }

  reconnect() {
    if (this.controller) this.controller.abort();
  }

  // A loop that is retrying still touches lastBeat; one that is stuck in a
  // read should never sit there much past the read's own 40 s abort.
  idleFor() {
    return Date.now() - this.lastBeat;
  }

  async loop() {
    // A read that fails leaves its own 40 s abort armed. Without clearing it
    // in a finally, every retry starts with a timer that can abort the *next*
    // read: after a gateway restart the card could stay "读取超时" for the
    // whole minute its timers were still queued. The timer belongs to one
    // attempt and dies with it, whatever the attempt did.
    while (!this.stopped) {
      let timeout = null;
      this.lastBeat = Date.now();
      try {
        this.controller = new AbortController();
        timeout = setTimeout(() => this.controller.abort(), 40000);
        const suffix = this.first ? '' : '&wait=1';
        const url = `${this.base}/v1/magpie/trace?after=${this.seq}${suffix}`;
        const response = await fetch(url, {
          signal: this.controller.signal,
          headers: { Accept: 'application/json' },
          cache: 'no-store',
        });
        if (!response.ok) {
          const error = new Error(`magpie answered ${response.status}`);
          error.status = response.status;
          throw error;
        }
        const data = await response.json();
        const pid = Number(data.pid) || 0;
        const restarted = (pid && this.pid && pid !== this.pid)
          || (this.seq > 0 && Number(data.seq) < this.seq);
        if (restarted) {
          // magpie started over: its sequence means nothing here any more, and
          // the routes it never ran must not stay on the card.
          this.pid = pid;
          this.seq = 0;
          this.first = true;
          this.routes.clear();
          continue;
        }
        this.pid = pid || this.pid;
        this.seq = Number(data.seq) || 0;
        this.first = false;
        this.lastError = '';
        this.misses = 0;
        for (const route of Array.isArray(data.routes) ? data.routes : []) {
          this.routes.set(String(route.id), route);
        }
        if (this.routes.size > 220) {
          const done = [...this.routes.values()]
            .filter((route) => route.done)
            .sort((a, b) => new Date(a.time) - new Date(b.time));
          for (const route of done) {
            if (this.routes.size <= 200) break;
            this.routes.delete(String(route.id));
          }
        }
        const snapshot = { ...data, routes: [...this.routes.values()] };
        lastTrace = snapshot;
        if (data.routes?.length || activeCount(snapshot.routes) > 0) markActivity();
        connection = { online: true, detail: this.base, at: Date.now() };
        fitWindow(activeCount(snapshot.routes));
        send('magpie:trace', snapshot);
        send('magpie:connection', connection);
      } catch (error) {
        if (this.stopped) break;
        const detail = describeError(error);
        if (detail !== this.lastError) {
          this.lastError = detail;
          log(`trace unavailable at ${this.base}: ${detail}`);
        }
        // magpie may come back on another port than the one it left on: the
        // address is resolved again on every retry instead of once at start.
        const base = resolveGateway();
        if (base !== this.base) {
          log(`trace gateway moved: ${this.base} -> ${base}`);
          this.base = base;
          this.pid = 0;
          this.seq = 0;
          this.first = true;
          this.routes.clear();
        }
        connection = { online: false, detail, retry: true, at: Date.now() };
        fitWindow(0);
        send('magpie:connection', connection);
        // Back off instead of hammering a gateway that is down: 1 s, 2 s, 4 s,
        // then a steady 5 s. The card shows "重连中" while the loop retries,
        // so no click and no setting is needed once magpie is back.
        this.misses = Math.min(this.misses + 1, 5);
        const wait = Math.min(1000 * 2 ** (this.misses - 1), 5000);
        await delay(wait);
        continue;
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    }
  }
}

// The trace loop is the card's only link to magpie, so it gets a watchdog of
// its own: a loop that dies or hangs is rebuilt instead of waiting for the
// user to find 重新连接 in the tray. This is on by default, with no setting.
const WATCHDOG_MS = 15000;
const STALLED_MS = 60000;
let watchdogTimer = null;

function watchTrace() {
  clearInterval(watchdogTimer);
  watchdogTimer = setInterval(() => {
    if (quitting || !client) return;
    if (client.idleFor() < STALLED_MS) return;
    log(`trace loop stalled for ${Math.round(client.idleFor() / 1000)}s: rebuilding`);
    rebuildClient();
    send('magpie:connection', { online: false, detail: '正在重新连接', retry: true });
  }, WATCHDOG_MS);
}

function describeError(error) {
  if (!error) return '读取失败';
  if (error.name === 'AbortError') return '读取超时';
  if (error.status) return `magpie answered ${error.status}`;
  if (error.cause && error.cause.code === 'ECONNREFUSED') return 'magpie 未运行或端口不可达';
  if (String(error.message || '').includes('ECONNREFUSED')) return 'magpie 未运行或端口不可达';
  return error.message || '读取失败';
}

function send(channel, payload) {
  if (!win || win.isDestroyed()) return;
  if (win.webContents.isDestroyed()) return;
  try {
    win.webContents.send(channel, payload);
  } catch (error) {
    // A payload the serializer cannot clone (a menu item, a function) used
    // to vanish without a trace: the window grew and the drawer stayed empty.
    log(`send ${channel}: ${error.message}`);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function trayImage() {
  let image;
  if (IS_MAC) {
    image = nativeImage.createFromPath(path.join(ASSETS, 'trayTemplate.png'));
    image.setTemplateImage(true);
    return image;
  }
  image = nativeImage.createFromPath(path.join(ASSETS, 'busy-magpie.ico'));
  if (image.isEmpty()) {
    image = nativeImage.createFromPath(path.join(ASSETS, 'icon.png')).resize({ width: 16, height: 16 });
  }
  return image;
}

function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(buildTrayMenu());
}

function buildTrayMenu() {
  const visible = Boolean(win && win.isVisible());
  const opacityItems = [100, 92, 84, 75].map((percent) => ({
    label: `${percent}%`,
    type: 'radio',
    checked: Math.abs(settings.opacity - percent / 100) < 0.01,
    click: () => setOpacity(percent / 100),
  }));

  return Menu.buildFromTemplate([
    {
      label: visible ? '隐藏桌面插件' : settings.pauseUntil > Date.now()
        ? '立即恢复显示（暂停中）' : `显示桌面插件（${displayHotkey()}）`,
      click: toggleVisible,
    },
    // The other one-click way in: a release the app already found installs
    // from here, without opening the about pane.
    ...(updateState.available && !updateState.skipped
      ? [{
        label: updateState.downloading || updateState.installing
          ? `正在更新 v${updateState.latest}…`
          : `更新到 v${updateState.latest}`,
        enabled: !updateState.downloading && !updateState.installing,
        click: () => { installUpdate(); },
      }]
      : []),
    {
      label: `全局快捷键 ${displayHotkey()}`,
      type: 'checkbox',
      checked: settings.hotkeyOn !== false && hotkeyOk,
      click: (item) => {
        settings.hotkeyOn = item.checked;
        saveSettings();
        registerHotkey();
        refreshTrayMenu();
      },
    },
    {
      label: app.isPackaged ? '开机自动启动' : '开机自动启动（需要安装版）',
      type: 'checkbox',
      enabled: app.isPackaged,
      checked: settings.autostart === true,
      click: (item) => {
        setAutostart(item.checked);
        refreshTrayMenu();
      },
    },
    {
      label: '总在最前',
      type: 'checkbox',
      checked: settings.topmost,
      click: (item) => {
        settings.topmost = item.checked;
        saveSettings();
        applyTopmost();
        send('magpie:settings', publicSettings());
        refreshTrayMenu();
      },
    },
    {
      label: '隐藏账号名称',
      type: 'checkbox',
      checked: settings.maskAccounts,
      click: (item) => {
        settings.maskAccounts = item.checked;
        saveSettings();
        send('magpie:settings', publicSettings());
        refreshTrayMenu();
      },
    },
    {
      label: '不透明度',
      submenu: opacityItems,
    },
    { type: 'separator' },
    {
      label: '设置…',
      // The menu passes (menuItem, window, event); leaving the item as the
      // mode would put a function into the IPC payload and drop the panel.
      click: () => openSettingsPanel('settings'),
    },
    {
      label: `关于 Busy Magpie…（v${app.getVersion()}）`,
      click: () => openAbout(),
    },
    {
      label: '调整位置…',
      click: beginLayout,
    },
    {
      label: '重新连接',
      click: () => {
        rebuildClient();
        send('magpie:connection', { online: false, detail: '正在重新连接' });
      },
    },
    {
      label: '打开设置文件',
      click: () => {
        if (!fs.existsSync(settingsPath)) saveSettings();
        shell.showItemInFolder(settingsPath);
      },
    },
    { type: 'separator' },
    {
      label: '暂停显示 1 小时（自动恢复）',
      click: pauseDisplay,
    },
    {
      label: '退出并停止自动拉起',
      click: quit,
    },
  ]);
}

// A quit is final: the card's own shortcuts are gone with the process, so
// the only way back is something outside it — a shortcut, the plugin
// relaunching it (it does that on load and on every request), or starting
// with the login session.
function setAutostart(on) {
  settings.autostart = Boolean(on);
  saveSettings();
  if (!app.isPackaged) {
    // electron.exe would be the thing started at login, not the widget.
    log('autostart needs the installed build; the dev run ignores it');
    return;
  }
  try {
    app.setLoginItemSettings({
      openAtLogin: settings.autostart,
      path: process.execPath,
      args: [],
    });
  } catch (error) {
    log(`autostart: ${error.message}`);
  }
}

function applyAutostart() {
  if (!app.isPackaged) return;
  try {
    app.setLoginItemSettings({
      openAtLogin: settings.autostart === true,
      path: process.execPath,
      args: [],
    });
  } catch (error) {
    log(`autostart: ${error.message}`);
  }
}

function createTray() {
  tray = new Tray(trayImage());
  tray.setToolTip(`Busy Magpie · ${displayHotkey()} 显示 / 隐藏`);
  refreshTrayMenu();
  if (IS_WIN) {
    // A single click brings the card back; double-click still toggles it.
    tray.on('click', () => {
      if (!win || win.isDestroyed() || win.isVisible()) return;
      showWindow();
    });
    tray.on('double-click', toggleVisible);
  }
}

function setOpacity(value) {
  settings.opacity = Math.min(1, Math.max(0.4, value));
  saveSettings();
  if (win && !win.isDestroyed()) win.setOpacity(settings.opacity);
  send('magpie:settings', publicSettings());
  refreshTrayMenu();
}

function quit() {
  if (!touchAlive(true)) log('quit: could not persist the manual stop marker');
  quitting = true;
  clearTimeout(pauseTimer);
  clearTimeout(layoutTimer);
  clearInterval(hoverTimer);
  clearInterval(usageTimer);
  clearInterval(updateTimer);
  clearInterval(quietTimer);
  quietTimer = null;
  globalShortcut.unregisterAll();
  clearInterval(aliveTimer);
  clearInterval(watchdogTimer);
  watchdogTimer = null;
  if (dragState) {
    clearInterval(dragState.timer);
    clearTimeout(dragState.max);
    dragState = null;
  }
  if (resizeState) {
    clearInterval(resizeState.timer);
    clearTimeout(resizeState.max);
    resizeState = null;
  }
  savePosition();
  if (client) client.stop();
  if (tray) {
    tray.destroy();
    tray = null;
  }
  if (win && !win.isDestroyed()) win.destroy();
  app.quit();
}

ipcMain.handle('busy:bootstrap', () => ({
  version: app.getVersion(),
  pluginVersion: PLUGIN_VERSION,
  update: updateView(),
  firstRun: firstRunOpen,
  settings: publicSettings(),
  hotkey: { accelerator: displayHotkey(), on: settings.hotkeyOn !== false, ok: hotkeyOk },
  connection,
  trace: lastTrace,
  usage: usageData,
  usageStatus,
  layout: layoutMode,
  frame,
}));

ipcMain.handle('settings:get', () => {
  let raw = '';
  try {
    raw = fs.readFileSync(settingsPath, 'utf8');
  } catch {
    raw = JSON.stringify(settings, null, 2);
  }
  return {
    version: app.getVersion(),
    settings: {
      ...settings,
      gateway: settings.gateway || '',
    },
    resolvedGateway: displayAddress(resolveGateway()),
    path: settingsPath,
    raw,
  };
});

ipcMain.handle('settings:save', (_event, input) => {
  try {
    const data = input && typeof input === 'object' ? input : {};
    const area = screen.getDisplayNearestPoint({
      x: settings.left ?? 0,
      y: settings.top ?? 0,
    }).workArea;
    let width = Math.max(600, Math.min(area.width - 20, Number(data.width) || settings.width || WIDTH));
    let height = heightForWidth(width);
    if (height > Math.min(area.height - 20, 1200)) {
      height = Math.max(432, Math.min(area.height - 20, 1200));
      width = Math.max(600, Math.min(area.width - 20, widthForHeight(height)));
      height = heightForWidth(width);
    }
    const rawGateway = String(data.gateway ?? '').trim();
    const nextGateway = rawGateway ? normalizeGateway(rawGateway) : null;
    const gatewayChanged = nextGateway !== settings.gateway;
    const sizeChanged = width !== settings.width || height !== settings.height;
    const nextPeriods = normalizePeriods(data.enabledPeriods ?? settings.enabledPeriods);
    const requestedPeriod = normalizePeriod(data.usagePeriod ?? settings.usagePeriod);
    const nextPeriod = nextPeriods.includes(requestedPeriod) ? requestedPeriod : nextPeriods[0];
    const periodChanged = nextPeriod !== settings.usagePeriod;
    const nextHotkey = String(data.hotkey ?? settings.hotkey ?? DEFAULT_HOTKEY).trim();
    const nextHotkeyOn = data.hotkeyOn === undefined
      ? settings.hotkeyOn !== false
      : Boolean(data.hotkeyOn);
    const hotkeyChanged = nextHotkey !== settings.hotkey
      || nextHotkeyOn !== (settings.hotkeyOn !== false);

    const nextSettings = {
      ...settings,
      topmost: Boolean(data.topmost),
      maskAccounts: Boolean(data.maskAccounts),
      opacity: Math.min(1, Math.max(0.4, Number(data.opacity) || 1)),
      gateway: nextGateway,
      width,
      height,
      checkUpdates: normalizeUpdateMode(data.updateMode ?? settings.updateMode) !== 'never',
      updateMode: normalizeUpdateMode(data.updateMode ?? settings.updateMode),
      usagePeriod: nextPeriod,
      enabledPeriods: nextPeriods,
      pillMetric: normalizeMetric(data.pillMetric ?? settings.pillMetric),
      rollTokens: data.rollTokens === undefined
        ? settings.rollTokens !== false
        : Boolean(data.rollTokens),
      showQuota: data.showQuota === undefined
        ? settings.showQuota !== false
        : Boolean(data.showQuota),
      showTiming: data.showTiming === undefined
        ? settings.showTiming !== false
        : Boolean(data.showTiming),
      hubEffect: normalizeHubEffect(data.hubEffect ?? settings.hubEffect),
      keepAlive: data.keepAlive === undefined
        ? settings.keepAlive !== false
        : Boolean(data.keepAlive),
      hotkey: nextHotkey,
      hotkeyOn: nextHotkeyOn,
    };
    if (win && !win.isDestroyed()) {
      const bounds = win.getBounds();
      nextSettings.left = bounds.x;
      nextSettings.top = bounds.y;
    }
    const saved = saveSettings(nextSettings);
    if (!saved.ok) return saved;
    settings = nextSettings;
    if (hotkeyChanged) registerHotkey();
    applyTopmost();
    if (win && !win.isDestroyed()) {
      win.setOpacity(settings.opacity);
      // While the settings drawer is open the window is deliberately
      // taller; do not collapse it from inside the save call.
      if (!settingsOpen) {
        const bounds = win.getBounds();
        win.setBounds({
          x: bounds.x,
          y: bounds.y,
          width: settings.width,
          height: settings.height,
        }, false);
        settings.left = bounds.x;
        settings.top = bounds.y;
        frame = {
          lanes: frame.lanes,
          cardHeight: settings.height - 32,
          windowHeight: settings.height,
        };
        send('magpie:frame', frame);
      }
    }
    send('magpie:settings', publicSettings());
    if (gatewayChanged) rebuildClient();
    else if (periodChanged) refreshUsage();
    if (settings.updateMode === 'idle') {
      if (updateState.ready) scheduleQuietInstall();
      else if (updateState.available) downloadUpdate();
    } else {
      clearInterval(quietTimer);
      quietTimer = null;
    }
    refreshTrayMenu();
    let raw = '';
    try {
      raw = fs.readFileSync(settingsPath, 'utf8');
    } catch {
      raw = JSON.stringify(settings, null, 2);
    }
    return {
      ok: true,
      sizeChanged,
      raw,
      path: settingsPath,
      settings: { ...settings, gateway: settings.gateway || '' },
      resolvedGateway: displayAddress(resolveGateway()),
    };
  } catch (error) {
    log(`save settings: ${error.message}`);
    return { ok: false, error: error.message };
  }
});

ipcMain.on('settings:open-file', () => {
  if (!fs.existsSync(settingsPath)) saveSettings();
  shell.showItemInFolder(settingsPath);
});

ipcMain.on('settings:close', () => closeSettingsPanel());

// While the slider is dragged the window follows it at once; nothing is
// written until Save, and closing the panel puts the stored value back.
ipcMain.on('settings:opacity', (_event, value) => {
  if (!win || win.isDestroyed()) return;
  win.setOpacity(Math.min(1, Math.max(0.4, Number(value) || 1)));
});

ipcMain.on('busy:ready', () => {
  rendererReady = true;
  if (pendingSettings) {
    pendingSettings = false;
    openSettingsPanel(pendingPanelMode);
  }
});

function openAbout() {
  openSettingsPanel('about');
}

ipcMain.on('busy:about-open', () => {
  openAbout();
});

ipcMain.on('busy:menu-toggle', () => setQuickMenuOpen(!quickMenuOpen));
ipcMain.on('busy:menu-close', () => setQuickMenuOpen(false));
ipcMain.on('busy:history-open', () => openSettingsPanel('history'));
ipcMain.on('busy:menu-action', (_event, action) => {
  if (!quickMenuOpen) return;
  switch (action) {
    case 'settings': openSettingsPanel(); break;
    case 'models': openSettingsPanel('models'); break;
    case 'history': openSettingsPanel('history'); break;
    case 'layout': beginLayout(); break;
    case 'hide': win.hide(); break;
    case 'pause': pauseDisplay(); break;
    case 'quit': quit(); break;
    case 'about':
      openAbout();
      checkForUpdates(true);
      break;
  }
});

ipcMain.handle('busy:copy-summary', (_event, text) => {
  if (typeof text !== 'string' || text.length > 12000) return false;
  clipboard.writeText(text);
  return true;
});

ipcMain.handle('updates:get', () => updateView());
ipcMain.handle('updates:check', () => checkForUpdates(true));
ipcMain.handle('updates:install', () => installUpdate());
ipcMain.handle('updates:skip', () => skipUpdate());
ipcMain.handle('updates:set-auto', (_event, value) => setCheckUpdates(value));
ipcMain.on('updates:open-release', () => {
  if (updateState.releaseUrl) shell.openExternal(updateState.releaseUrl);
});

ipcMain.on('busy:first-run-dismiss', () => {
  if (!firstRunOpen) return;
  firstRunOpen = false;
  applyClickThrough();
  send('magpie:first-run', false);
  if (win && !win.isDestroyed()) {
    win.setFocusable(false);
    win.blur();
  }
});

ipcMain.on('busy:open-install-dir', () => {
  shell.openPath(path.dirname(app.getPath('exe')));
});

ipcMain.on('busy:end-layout', () => endLayout());
ipcMain.on('busy:drag-start', () => startDrag());
ipcMain.on('busy:drag-end', () => endDrag());
ipcMain.on('busy:resize-start', (_event, direction) => startResize(direction));
ipcMain.on('busy:resize-end', () => endResize());
ipcMain.on('busy:hit-areas', (_event, areas) => setHitAreas(areas));
ipcMain.handle('usage:set-period', (_event, period) => setUsagePeriod(period));

function init() {
  settingsPath = path.join(app.getPath('userData'), 'settings.json');
  logPath = path.join(app.getPath('userData'), 'busy-magpie.log');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  try {
    // The plugin compares this with the latest GitHub release before updating.
    fs.writeFileSync(path.join(app.getPath('userData'), 'version'), app.getVersion());
  } catch {
    // A version marker is an optimization, never a reason not to start.
  }
  settings = loadSettings();
  if (!PLUGIN_VERSION || settings.pauseUntil <= Date.now()) settings.pauseUntil = 0;
  // A marker left by an install that did not finish would keep the launcher
  // from starting the card; this process running means it is over.
  clearUpdatingMarker();
  setupUpdater();

  if (IS_MAC) app.dock.hide();
  if (IS_WIN) app.setAppUserModelId('dev.busymagpie.widget');

  createWindow();
  createTray();
  registerHotkey();
  applyAutostart();
  touchAlive();
  schedulePauseResume();
  aliveTimer = setInterval(touchAlive, 10000);
  watchHover();
  rebuildClient();
  watchTrace();
  usageTimer = setInterval(refreshUsage, 20000);
  setTimeout(() => checkForUpdates(false), 2500);
  updateTimer = setInterval(() => checkForUpdates(false), UPDATE_CHECK_MS);

  if (START_IN_LAYOUT) {
    setTimeout(beginLayout, 1500);
  }
  if (START_IN_SETTINGS) {
    setTimeout(openSettingsPanel, 1200);
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) showWindow();
  });

  app.whenReady().then(init);

  app.on('activate', () => {
    if (win) showWindow();
  });

  app.on('window-all-closed', () => {
    // The widget lives in the tray; closing the card only hides it.
  });

  app.on('before-quit', () => {
    quitting = true;
    if (client) client.stop();
  });

  process.on('uncaughtException', (error) => {
    log(`uncaught: ${error.stack || error.message}`);
  });
  process.on('unhandledRejection', (reason) => {
    log(`unhandled rejection: ${reason && reason.stack ? reason.stack : reason}`);
  });
}
