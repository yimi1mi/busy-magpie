'use strict';

const {
  app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, screen, shell,
} = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

app.setName('Busy Magpie');

const WIDTH = 632;
const HEIGHT = 432;
const ASSETS = path.join(__dirname, '..', 'assets');
const RENDERER = path.join(__dirname, '..', 'web', 'index.html');
const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';
const START_IN_LAYOUT = process.argv.includes('--layout');
const START_IN_SETTINGS = process.argv.includes('--settings');

let win = null;
let settingsOpen = false;
let settingsClosing = false;
let rendererReady = false;
let pendingSettings = false;
let settingsBaseBounds = null;
let settingsPaneHeight = 430;
let boundsAnimation = null;
let tray = null;
let settings = null;
let settingsPath = null;
let logPath = null;
let client = null;
let lastTrace = null;
let usageData = null;
let usageTimer = null;
let connection = { online: false, detail: '正在连接' };
let layoutMode = false;
let layoutTimer = null;
let hoverInteractive = false;
let hoverKind = null;
let dragState = null;
let resizeState = null;
let hoverTimer = null;
let quitting = false;
let positionTimer = null;
let frame = { lanes: 1, cardHeight: 400, windowHeight: 432 };

function log(message) {
  try {
    fs.appendFileSync(logPath, `${new Date().toISOString()}  ${message}\n`);
  } catch {
    // Logging must never take the widget down.
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
  };
}

function loadSettings() {
  try {
    const raw = fs.readFileSync(settingsPath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      ...defaults(),
      ...parsed,
      opacity: Math.min(1, Math.max(0.4, Number(parsed.opacity) || 1)),
      width: Math.max(600, Math.min(1600, Number(parsed.width) || WIDTH)),
      height: Math.max(432, Math.min(1200, Number(parsed.height) || HEIGHT)),
    };
  } catch {
    return defaults();
  }
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
  } catch (error) {
    log(`save settings: ${error.message}`);
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
  const width = Math.min(settings.width || WIDTH, area.width - 20);
  const height = Math.min(settings.height || HEIGHT, area.height - 20);
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
    win.showInactive();
    applyClickThrough();
    applyTopmost();
  });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  win.webContents.on('before-input-event', (event, input) => {
    if ((settingsOpen || layoutMode || dragState || resizeState)
      && input.type === 'keyDown' && input.key === 'Escape') {
      if (settingsOpen) closeSettingsPanel();
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
    if (settingsOpen) closeSettingsPanel();
    hoverInteractive = false;
    hoverKind = null;
    refreshTrayMenu();
  });

  win.webContents.on('did-start-loading', () => { rendererReady = false; });
  win.webContents.on('did-finish-load', () => {
    win.webContents.send('magpie:settings', publicSettings());
    win.webContents.send('magpie:frame', frame);
    if (lastTrace) win.webContents.send('magpie:trace', lastTrace);
    win.webContents.send('magpie:connection', connection);
    win.webContents.send('magpie:layout', layoutMode);
    if (settingsOpen && settingsBaseBounds) {
      win.webContents.send('magpie:settings-panel', {
        open: true,
        baseCardHeight: settingsBaseBounds.height - 32,
        paneHeight: settingsPaneHeight,
      });
    }
  });
}

function publicSettings() {
  return {
    maskAccounts: settings.maskAccounts,
    topmost: settings.topmost,
    opacity: settings.opacity,
    gateway: displayAddress(resolveGateway()),
  };
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
  if (settingsOpen || settingsClosing || layoutMode || hoverInteractive) {
    win.setIgnoreMouseEvents(false);
    win.setFocusable(true);
  } else {
    win.setIgnoreMouseEvents(true, { forward: true });
    win.setFocusable(false);
  }
}

function showWindow() {
  if (!win || win.isDestroyed()) return;
  if (!win.isVisible()) win.showInactive();
  applyClickThrough();
  applyTopmost();
  refreshTrayMenu();
}

function stopBoundsAnimation() {
  if (!boundsAnimation) return;
  clearTimeout(boundsAnimation);
  boundsAnimation = null;
}

function animateBounds(from, to, duration, done) {
  stopBoundsAnimation();
  const start = Date.now();
  const ease = (value) => 1 - (1 - value) ** 3;
  const step = () => {
    if (!win || win.isDestroyed()) {
      boundsAnimation = null;
      return;
    }
    const t = Math.min(1, (Date.now() - start) / duration);
    const k = ease(t);
    win.setBounds({
      x: Math.round(from.x + (to.x - from.x) * k),
      y: Math.round(from.y + (to.y - from.y) * k),
      width: Math.round(from.width + (to.width - from.width) * k),
      height: Math.round(from.height + (to.height - from.height) * k),
    }, false);
    if (t < 1) {
      boundsAnimation = setTimeout(step, 16);
    } else {
      boundsAnimation = null;
      if (done) done();
    }
  };
  step();
}

function openSettingsPanel() {
  if (!win || win.isDestroyed()) return;
  if (!rendererReady) {
    pendingSettings = true;
    return;
  }
  if (settingsOpen || settingsClosing) {
    win.showInactive();
    win.focus();
    return;
  }
  if (!win.isVisible()) win.showInactive();

  settingsBaseBounds = win.getBounds();
  const display = screen.getDisplayNearestPoint({
    x: settingsBaseBounds.x,
    y: settingsBaseBounds.y,
  });
  const area = display.workArea;
  const preferred = 430;
  const maxPane = Math.max(260, area.height - settingsBaseBounds.height - 16);
  const paneHeight = Math.min(preferred, maxPane);
  settingsPaneHeight = paneHeight;
  const height = settingsBaseBounds.height + paneHeight;
  let y = settingsBaseBounds.y;
  if (y + height > area.y + area.height - 8) {
    y = Math.max(area.y + 8, area.y + area.height - height - 8);
  }

  settingsOpen = true;
  settingsClosing = false;
  hoverInteractive = false;
  win.setIgnoreMouseEvents(false);
  win.setFocusable(true);
  win.focus();
  send('magpie:settings-panel', {
    open: true,
    baseCardHeight: settingsBaseBounds.height - 32,
    paneHeight,
  });
  animateBounds(settingsBaseBounds, {
    x: settingsBaseBounds.x,
    y,
    width: settingsBaseBounds.width,
    height,
  }, 280);
  refreshTrayMenu();
}

function closeSettingsPanel() {
  if (!settingsOpen || settingsClosing) return;
  settingsClosing = true;
  settingsOpen = false;
  const from = win && !win.isDestroyed() ? win.getBounds() : settingsBaseBounds;
  const to = settingsBaseBounds;
  send('magpie:settings-panel', { open: false });
  if (!win || win.isDestroyed() || !to) {
    settingsBaseBounds = null;
    settingsClosing = false;
    return;
  }
  setTimeout(() => {
    animateBounds(from, to, 220, () => {
      if (win && !win.isDestroyed()) {
        win.setIgnoreMouseEvents(true, { forward: true });
        win.setFocusable(false);
        win.blur();
        applyTopmost();
      }
      settings.left = to.x;
      settings.top = to.y;
      settingsBaseBounds = null;
      settingsClosing = false;
      hoverInteractive = false;
      hoverKind = null;
      refreshTrayMenu();
    });
  }, 30);
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
    if (!win || win.isDestroyed() || !win.isVisible() || settingsOpen || settingsClosing || layoutMode || dragState || resizeState) return;
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
      && point.y >= bounds.y + 12
      && point.y <= bounds.y + 46;
    const kind = onBorder ? 'resize' : onTopBar ? 'drag' : null;
    setHoverInteractive(Boolean(kind), kind);
  }, 70);
}

function startDrag() {
  if (!win || win.isDestroyed() || settingsOpen || settingsClosing || dragState) return;
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
  if (!win || win.isDestroyed() || settingsOpen || settingsClosing || resizeState) return;
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
      x = state.x + state.width - width;
    }
    if (dir.includes('s')) {
      height = Math.max(state.minHeight, Math.min(state.maxH, state.height + dy));
    } else if (dir.includes('n')) {
      height = Math.max(state.minHeight, Math.min(state.maxH, state.height - dy));
      y = state.y + state.height - height;
    }

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
    win.setIgnoreMouseEvents(true, { forward: true });
    win.setFocusable(false);
    win.blur();
    applyTopmost();
    const bounds = win.getBounds();
    frame = { lanes: frame.lanes, cardHeight: bounds.height - 32, windowHeight: bounds.height };
    send('magpie:frame', frame);
    send('magpie:resize', false);
  }
  refreshTrayMenu();
}

function beginLayout() {
  if (!win || win.isDestroyed() || settingsOpen || settingsClosing || layoutMode) return;
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
  refreshUsage();
}

async function refreshUsage() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const response = await fetch(`${resolveGateway()}/v1/magpie/usage`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!response.ok) {
      log(`usage answered ${response.status}`);
      return;
    }
    usageData = await response.json();
    send('magpie:usage', usageData);
  } catch (error) {
    // A usage failure leaves the existing total on screen.
    log(`usage unavailable: ${error.message}`);
  } finally {
    clearTimeout(timeout);
  }
}

class TraceClient {
  constructor(base) {
    this.base = base;
    this.seq = 0;
    this.first = true;
    this.stopped = false;
    this.controller = null;
    this.lastError = '';
    // The endpoint after a non-zero seq returns only changed routes, not a
    // full snapshot. Keep the union so a request that started earlier stays
    // on the card until it is done.
    this.routes = new Map();
  }

  start() {
    this.stopped = false;
    this.loop();
  }

  stop() {
    this.stopped = true;
    if (this.controller) this.controller.abort();
  }

  reconnect() {
    if (this.controller) this.controller.abort();
  }

  async loop() {
    while (!this.stopped) {
      try {
        this.controller = new AbortController();
        const timeout = setTimeout(() => this.controller.abort(), 40000);
        const suffix = this.first ? '' : '&wait=1';
        const url = `${this.base}/v1/magpie/trace?after=${this.seq}${suffix}`;
        const response = await fetch(url, {
          signal: this.controller.signal,
          headers: { Accept: 'application/json' },
          cache: 'no-store',
        });
        clearTimeout(timeout);
        if (!response.ok) {
          const error = new Error(`magpie answered ${response.status}`);
          error.status = response.status;
          throw error;
        }
        const data = await response.json();
        if (this.seq > 0 && Number(data.seq) < this.seq) {
          this.seq = 0;
          this.first = true;
          this.routes.clear();
          continue;
        }
        this.seq = Number(data.seq) || 0;
        this.first = false;
        this.lastError = '';
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
        connection = { online: false, detail, at: Date.now() };
        fitWindow(0);
        send('magpie:connection', connection);
        await delay(2000);
      }
    }
  }
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
  win.webContents.send(channel, payload);
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
      label: visible ? '隐藏桌面插件' : '显示桌面插件',
      click: toggleVisible,
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
      click: openSettingsPanel,
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
      label: '退出',
      click: quit,
    },
  ]);
}

function createTray() {
  tray = new Tray(trayImage());
  tray.setToolTip('Busy Magpie · magpie 路由桌面插件');
  refreshTrayMenu();
  if (IS_WIN) {
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
  quitting = true;
  clearTimeout(layoutTimer);
  clearInterval(hoverTimer);
  clearInterval(usageTimer);
  stopBoundsAnimation();
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
  settings: publicSettings(),
  connection,
  trace: lastTrace,
  usage: usageData,
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
    const width = Math.max(600, Math.min(area.width - 20, Number(data.width) || settings.width || WIDTH));
    const height = Math.max(432, Math.min(area.height - 20, Number(data.height) || settings.height || HEIGHT));
    const rawGateway = String(data.gateway ?? '').trim();
    const nextGateway = rawGateway ? normalizeGateway(rawGateway) : null;
    const gatewayChanged = nextGateway !== settings.gateway;
    const sizeChanged = width !== settings.width || height !== settings.height;

    settings = {
      ...settings,
      topmost: Boolean(data.topmost),
      maskAccounts: Boolean(data.maskAccounts),
      opacity: Math.min(1, Math.max(0.4, Number(data.opacity) || 1)),
      gateway: nextGateway,
      width,
      height,
    };
    saveSettings();
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
    saveSettings();
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

ipcMain.on('busy:ready', () => {
  rendererReady = true;
  if (pendingSettings) {
    pendingSettings = false;
    openSettingsPanel();
  }
});

ipcMain.on('busy:end-layout', () => endLayout());
ipcMain.on('busy:drag-start', () => startDrag());
ipcMain.on('busy:drag-end', () => endDrag());
ipcMain.on('busy:resize-start', (_event, direction) => startResize(direction));
ipcMain.on('busy:resize-end', () => endResize());

function init() {
  settingsPath = path.join(app.getPath('userData'), 'settings.json');
  logPath = path.join(app.getPath('userData'), 'busy-magpie.log');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  settings = loadSettings();

  if (IS_MAC) app.dock.hide();
  if (IS_WIN) app.setAppUserModelId('dev.busymagpie.widget');

  createWindow();
  createTray();
  watchHover();
  rebuildClient();
  usageTimer = setInterval(refreshUsage, 20000);

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
