const { app, BrowserWindow, ipcMain, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const Module = require('node:module');

// Run with Electron on Windows, not offscreen: the regression occurs in the
// native DIP/pixel conversion. Example: electron tests/ui/drag-bounds.cjs --scale=1.75
assert.equal(process.platform, 'win32', 'this regression requires native Windows bounds');
const option = (name, fallback) => process.argv.find(arg => arg.startsWith(`--${name}=`))?.split('=')[1] || fallback;
const scale = option('scale', '1.75');
assert.ok(['1', '1.25', '1.5', '1.75', '2'].includes(scale));
const label = option('label', 'current');
assert.match(label, /^[a-z0-9-]+$/);
const initialWorkArea = option('work-area', '');
assert.ok(!initialWorkArea || /^\d{3,4}x\d{3,4}$/.test(initialWorkArea), 'use --work-area=WIDTHxHEIGHT in DIP');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'artifacts', 'drag-bounds', `${label}-${scale}`);
const profile = path.join(output, `profile-${process.pid}`);
fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
app.setPath('sessionData', profile);
app.getVersion = () => JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
app.commandLine.appendSwitch('force-device-scale-factor', scale);
app.disableHardwareAcceleration();

let win, finished = false, dragCalls = 0, resizeCalls = 0;
let cursor = { x: -10000, y: -10000 };
let workArea = initialWorkArea ? {
  x: 0, y: 0, width: Number(initialWorkArea.split('x')[0]), height: Number(initialWorkArea.split('x')[1]),
} : null;
const checks = [], samples = [], boundsCalls = [], ignoreCalls = [], rendererErrors = [];
const layoutSizes = {};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const js = source => win.webContents.executeJavaScript(source);
const size = bounds => ({ width: bounds.width, height: bounds.height });
const sample = name => {
  const bounds = win.getBounds();
  samples.push({ name, ...bounds });
  return bounds;
};
const record = name => { checks.push(name); console.log('PASS', name); };
const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  const data = url.pathname.endsWith('/usage')
    ? { period: 'today', calls: 0, input: 0, output: 0 }
    : { pid: 1, seq: 1, totals: { requests: 0 }, routes: [] };
  setTimeout(() => {
    if (response.destroyed) return;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(data));
  }, url.searchParams.has('wait') ? 100 : 0);
});

function finish(error) {
  if (finished) return;
  finished = true;
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({
    ok: !error, scale, initialWorkArea, electron: process.versions.electron, checks, samples, layoutSizes,
    boundsCalls, ignoreCalls, rendererErrors, error: error?.stack,
  }, null, 2));
  if (error) console.error(error.stack);
  server.closeAllConnections();
  server.close();
  win?.destroy();
  app.exit(error ? 1 : 0);
}

async function press() {
  const bounds = win.getBounds();
  cursor = { x: bounds.x + 100, y: bounds.y + 20 };
  await sleep(85);
  const before = dragCalls;
  await js(`document.getElementById(document.body.classList.contains('compact') ? 'compactDragBar' : 'dragBar').dispatchEvent(new PointerEvent('pointerdown',
    {bubbles:true,button:0,buttons:1,pointerId:1,clientX:100,clientY:20}))`);
  const deadline = Date.now() + 1500;
  while (dragCalls === before && Date.now() < deadline) await sleep(20);
  assert.equal(dragCalls, before + 1, 'long press must reach the production drag handler');
  return { ...cursor };
}

async function release() {
  await js(`window.dispatchEvent(new PointerEvent('pointerup',
    {bubbles:true,button:0,buttons:0,pointerId:1}))`);
  await sleep(40);
}

async function repeatedDrags(name, expectedSize, attempts = 12) {
  const repeated = [];
  for (let attempt = 0; attempt < attempts; attempt++) {
    const before = win.getBounds();
    const pointer = await press();
    const callsBeforeMove = boundsCalls.length;
    cursor = { x: pointer.x + 32, y: pointer.y + 24 };
    await sleep(60);
    const moved = sample(`${name} moved ${attempt}`);
    assert.ok(Math.abs(moved.x - before.x - 32) <= 1 && Math.abs(moved.y - before.y - 24) <= 1,
      'the window must follow the cursor');
    assert.equal(boundsCalls.length, callsBeforeMove + 1, 'one pointer change needs one native bounds write');
    const submitted = boundsCalls.at(-1);
    assert.deepEqual(size(submitted), expectedSize, 'dragging must reuse the application layout size');
    await sleep(85);
    assert.deepEqual(win.getBounds(), moved, 'holding after moving must not grow the window');
    cursor = pointer;
    await sleep(55);
    await release();
    const home = sample(`${name} released ${attempt}`);
    repeated.push(size(home));
    cursor = { x: pointer.x + 90, y: pointer.y + 75 };
    await sleep(50);
    assert.deepEqual(win.getBounds(), home, 'release must stop position and size changes');
  }
  assert.ok(repeated.every(value => value.width >= expectedSize.width && value.width <= expectedSize.width + 2
    && value.height >= expectedSize.height && value.height <= expectedSize.height + 2),
    `${name}: repeated drags must not accumulate native size rounding: ${JSON.stringify(repeated)}`);
  record(`${name}: movement, stationary hold, release and ${attempts} successive drags preserve size`);
}

async function displayChanged() {
  screen.emit('display-metrics-changed', {}, screen.getPrimaryDisplay(), ['workArea']);
  await sleep(260);
}

async function layoutSize() {
  const saved = await js('window.busy.settingsGet()');
  return { width: saved.settings.width, height: saved.settings.height };
}

async function run() {
  try {
    const original = sample('initial');
    const writes = boundsCalls.length;
    await press();
    for (let index = 0; index < 12; index++) {
      await sleep(60);
      assert.deepEqual(sample(`stationary ${index}`), original, 'stationary long press must not change native bounds');
    }
    await release();
    assert.equal(boundsCalls.length, writes, 'stationary dragging must not rewrite native bounds');
    record('stationary long press makes no native bounds writes');

    // Startup fits the requested size to the runner's logical work area. Keep
    // that accepted size fixed across every gesture, rather than assuming a
    // 632x432 desktop or reading the rounded native bounds back as the target.
    layoutSizes.normal = await layoutSize();
    await repeatedDrags('normal', layoutSizes.normal);
    await js('window.busy.toggleCompact()');
    await sleep(120);
    await repeatedDrags('compact', { width: 360, height: 112 });
    await js('window.busy.toggleCompact()');
    await sleep(120);

    const beforeResize = win.getBounds();
    // Supply room for an actual enlargement even on a CI desktop narrower than
    // the card. This changes only the app's resize constraint, not its native
    // window or the DIP/pixel conversion exercised by dragging.
    workArea = { x: beforeResize.x - 100, y: beforeResize.y - 100,
      width: beforeResize.width + 400, height: beforeResize.height + 400 };
    cursor = { x: beforeResize.x + beforeResize.width - 2, y: beforeResize.y + beforeResize.height - 2 };
    const resizeStarts = resizeCalls;
    await js('window.busy.resizeStart("se")');
    const resizeDeadline = Date.now() + 1500;
    while (resizeCalls === resizeStarts && Date.now() < resizeDeadline) await sleep(20);
    assert.equal(resizeCalls, resizeStarts + 1, 'resize must reach the production handler before moving');
    cursor = { x: cursor.x + 44, y: cursor.y + 30 };
    await sleep(90);
    await js('window.busy.resizeEnd()');
    await sleep(80);
    const resized = layoutSizes.resized = await layoutSize();
    assert.ok(resized.width >= beforeResize.width + 40 && resized.height > beforeResize.height,
      'the resize control must enlarge the actual starting dimensions');
    await repeatedDrags('resized', resized);

    for (let attempt = 0; attempt < 4; attempt++) await displayChanged();
    assert.deepEqual(await layoutSize(), resized, 'screen notifications must not feed rounded native sizes back into settings');
    await js('window.busy.toggleCompact()');
    await sleep(100);
    await js('window.busy.toggleMenu()');
    await sleep(100);
    const menuBounds = sample('compact menu expanded');
    await displayChanged();
    assert.deepEqual(win.getBounds(), menuBounds, 'screen recovery must retain the expanded compact menu');
    assert.deepEqual(await layoutSize(), resized);
    await js('window.busy.closeMenu()');
    await sleep(100);
    await js('window.busy.aboutOpen()');
    await sleep(100);
    const panelBounds = sample('compact about expanded');
    await displayChanged();
    assert.deepEqual(win.getBounds(), panelBounds, 'screen recovery must retain the expanded settings panel');
    assert.deepEqual(await layoutSize(), resized);
    await js('window.busy.settingsClose()');
    await sleep(250);
    assert.ok(win.getBounds().height <= 114, 'closing the panel must restore compact mode');
    await js('window.busy.toggleCompact()');
    await sleep(100);
    record('screen recovery preserves logical dimensions and expanded panels');

    workArea = { x: 0, y: 0, width: 600, height: 420 };
    await displayChanged();
    const fitted = layoutSizes.fitted = await layoutSize();
    assert.ok(fitted.width <= 580 && fitted.height <= 400, 'a smaller work area must still fit the card');
    await repeatedDrags('screen fitted', fitted, 3);
    assert.ok(ignoreCalls.length > 0 && ignoreCalls.every(value => value === false),
      'the v1.4.2 panel must never enable click-through');
    assert.equal(rendererErrors.length, 0, rendererErrors.join('\n'));
    record('resizing and v1.4.2 pointer blocking remain intact');
    finish();
  } catch (error) { finish(error); }
}

server.listen(0, '127.0.0.1', async () => {
  try {
    fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({
      gateway: `http://127.0.0.1:${server.address().port}`, width: 632, left: 40, top: 40,
      topmost: false, autostart: false, keepAlive: false, updateMode: 'never', quietMotion: true,
    }));
    await app.whenReady();
    screen.getCursorScreenPoint = () => cursor;
    for (const method of ['getPrimaryDisplay', 'getDisplayNearestPoint', 'getDisplayMatching']) {
      const original = screen[method].bind(screen);
      screen[method] = (...args) => {
        const display = original(...args);
        return workArea ? { ...display, workArea: { ...workArea } } : display;
      };
    }
    app.on('browser-window-created', (_event, created) => {
      win = created;
      // Keep the real HWND and DPI conversion while leaving the user's desktop
      // visually unchanged. Focus is the only native interaction suppressed.
      win.setOpacity(0);
      win.focus = () => {};
      win.blur = () => win.emit('blur');
      const setBounds = win.setBounds.bind(win);
      win.setBounds = (bounds, animate) => { boundsCalls.push({ ...bounds }); setBounds(bounds, animate); };
      const setPosition = win.setPosition.bind(win);
      win.setPosition = (x, y, animate) => { boundsCalls.push({ x, y, via: 'setPosition' }); setPosition(x, y, animate); };
      const ignore = win.setIgnoreMouseEvents.bind(win);
      win.setIgnoreMouseEvents = (value, options) => { ignoreCalls.push(value); ignore(value, options); };
      win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) rendererErrors.push(message); });
    });
    ipcMain.on('busy:drag-start', () => { dragCalls++; });
    ipcMain.on('busy:resize-start', () => { resizeCalls++; });
    ipcMain.once('busy:ready', () => setTimeout(run, 200));
    const filename = path.join(root, 'src/main.js');
    const main = new Module(filename, module);
    main.filename = filename;
    main.paths = Module._nodeModulePaths(path.dirname(filename));
    main._compile(fs.readFileSync(filename, 'utf8'), filename);
  } catch (error) { finish(error); }
});
setTimeout(() => finish(new Error('native drag regression timed out')), 45000).unref();
