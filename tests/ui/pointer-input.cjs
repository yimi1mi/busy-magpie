const { app, BrowserWindow, ipcMain, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const Module = require('node:module');

const root = path.resolve(__dirname, '../..');
const native = process.argv.includes('--native');
const fallback = process.argv.includes('--fallback');
assert.ok(!native || process.platform === 'win32', 'native hit tests require Windows');
const output = path.join(root, 'artifacts', `pointer-input${native ? '-native' : ''}${fallback ? '-fallback' : ''}`);
const profile = path.join(output, `profile-${process.pid}`);
fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
app.setPath('sessionData', profile);
app.getVersion = () => JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
app.disableHardwareAcceleration();

const checks = [], ignoreCalls = [], errors = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let win, back, finished = false, ignored, visible = false, nativeHit;
let cursor = { x: -10000, y: -10000 };
const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  const data = url.pathname.endsWith('/usage')
    ? { period: url.searchParams.get('period') || 'today', input: 42, output: 7, calls: 1 }
    : { pid: 1, seq: 1, totals: { requests: 0 }, routes: [] };
  setTimeout(() => {
    if (response.destroyed) return;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(data));
  }, url.searchParams.has('wait') ? 100 : 0);
});
const js = code => win.webContents.executeJavaScript(code);
const click = async id => { await js(`document.getElementById(${JSON.stringify(id)}).click()`); await sleep(80); };
const record = name => { checks.push(name); console.log('PASS', name); };

function finish(error) {
  if (finished) return;
  finished = true;
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({
    ok: !error, native, fallback, platform: process.platform, checks, ignoreCalls,
    rendererErrors: errors, error: error?.stack,
  }, null, 2));
  if (error) console.error(error.stack);
  server.closeAllConnections();
  server.close();
  win?.destroy();
  back?.destroy();
  app.exit(error ? 1 : 0);
}

function windowsHitTest() {
  const k = require('koffi'), user = k.load('user32.dll');
  const Point = k.struct({ x: 'int32', y: 'int32' });
  const Rect = k.struct({ left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
  const at = user.func('__stdcall', 'WindowFromPoint', 'uintptr_t', [Point]);
  const ancestor = user.func('uintptr_t __stdcall GetAncestor(uintptr_t,uint32)');
  const rect = user.func('__stdcall', 'GetWindowRect', 'int', ['uintptr_t', k.out(k.pointer(Rect))]);
  const client = user.func('__stdcall', 'ScreenToClient', 'int', ['uintptr_t', k.inout(k.pointer(Point))]);
  const post = user.func('int __stdcall PostMessageW(uintptr_t,uint32,uintptr_t,intptr_t)');
  const flush = k.load('dwmapi.dll').func('int __stdcall DwmFlush()');
  const handle = window => window.getNativeWindowHandle().readBigUInt64LE();
  return async (label, target = win, sendClick = true) => {
    // Keep this fixture above its rear window even when focusability changes.
    win.moveTop();
    await sleep(60);
    flush();
    const area = await js(`(() => {const r=document.getElementById('card').getBoundingClientRect();
      return {x:Math.round(r.x+r.width*0.2),y:Math.round(r.y+r.height*0.65)};})()`);
    const physical = {};
    assert.ok(rect(handle(win), physical));
    const scale = (physical.right - physical.left) / win.getBounds().width;
    const point = { x: physical.left + Math.round(area.x * scale), y: physical.top + Math.round(area.y * scale) };
    const hit = at(point);
    const hitRoot = BigInt(ancestor(hit, 2));
    const hitRole = hitRoot === handle(win) ? 'panel' : hitRoot === handle(back) ? 'rear fixture' : 'another window';
    assert.equal(hitRoot, handle(target), `${label}: Windows routes the point to ${hitRole}`);
    if (!sendClick) return;
    const before = await js('window.__pointerDowns');
    assert.ok(client(hit, point));
    const position = (point.y << 16) | (point.x & 0xffff);
    assert.ok(post(hit, 0x0201, 1, position));
    assert.ok(post(hit, 0x0202, 0, position));
    await sleep(100);
    assert.equal(await js('window.__pointerDowns'), before + 1, `${label}: panel did not receive the native mouse messages`);
    assert.equal(await back.webContents.executeJavaScript('window.__pointerDowns'), 0, `${label}: click reached the rear window`);
  };
}

async function blocksClicks(label) {
  assert.equal(ignored, false, `${label}: panel must block clicks`);
  assert.ok(ignoreCalls.every(value => value === false), `${label}: a state transition enabled click-through`);
  if (nativeHit) await nativeHit(label);
  record(label);
}

async function run() {
  try {
    await js('window.__pointerDowns=0;document.addEventListener("pointerdown",()=>window.__pointerDowns++,true)');
    if (native) {
      nativeHit = windowsHitTest();
      // Prove the native probe detects the previous behavior before trusting it.
      win.setIgnoreMouseEvents(true, { forward: true });
      ignoreCalls.pop();
      await nativeHit('negative control detects pass-through', back, false);
      win.setIgnoreMouseEvents(false);
      record('native hit test distinguishes the panel from the rear window');
    }
    await blocksClicks('main panel blocks clicks before hovering controls');
    const bounds = win.getBounds();
    cursor = { x: bounds.x + 100, y: bounds.y + 20 };
    await sleep(100);
    cursor = { x: -10000, y: -10000 };
    await sleep(100);
    await blocksClicks('leaving the drag strip keeps panel clicks blocked');

    const period = await js('window.busy.bootstrap().then(data=>data.settings.usagePeriod)');
    await click('tokenPill');
    assert.notEqual(await js('window.busy.bootstrap().then(data=>data.settings.usagePeriod)'), period);
    record('the token pill still switches usage periods');
    await click('quickMenuToggle');
    assert.equal(await js('document.getElementById("quickMenu").hidden'), false);
    await js('window.busy.closeMenu()');
    await sleep(100);
    await blocksClicks('closing the quick menu keeps panel clicks blocked');

    await click('quickMenuToggle');
    await js('document.querySelector("[data-menu-action=settings]").click()');
    await sleep(100);
    await blocksClicks('settings block panel clicks');
    await js('window.busy.settingsClose()');
    await sleep(250);
    await blocksClicks('settings fade-out keeps panel clicks blocked');
    await js('window.busy.aboutOpen()');
    await sleep(100);
    await blocksClicks('about blocks panel clicks');
    await js('window.busy.settingsClose()');
    await sleep(250);
    await blocksClicks('closing about keeps panel clicks blocked');

    await js('window.busy.dragStart()');
    await sleep(30);
    await js('window.busy.dragEnd()');
    await blocksClicks('drag release keeps panel clicks blocked');
    await js('window.busy.resizeStart("se")');
    await sleep(30);
    await js('window.busy.resizeEnd()');
    await blocksClicks('resize release keeps panel clicks blocked');

    for (const opacity of [0.3, 1, 0]) {
      const result = await js(`(async()=>{const data=await window.busy.settingsGet();
        return window.busy.settingsSave({...data.settings,opacity:${opacity}});})()`);
      assert.equal(result.ok, true);
      await sleep(100);
      await blocksClicks(`background opacity ${opacity} keeps panel clicks blocked`);
    }
    await js('window.busy.toggleCompact()');
    await sleep(100);
    assert.deepEqual(win.getSize(), [360, 112]);
    await blocksClicks('compact panel blocks clicks');
    await click('compactMenu');
    await js('window.busy.closeMenu()');
    await sleep(100);
    await blocksClicks('closing the compact menu keeps panel clicks blocked');
    await click('compactExpand');
    await blocksClicks('expanding the compact panel keeps panel clicks blocked');
    assert.equal(errors.length, 0, errors.join('\n'));
    finish();
  } catch (error) { finish(error); }
}

server.listen(0, '127.0.0.1', async () => {
  try {
    fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({
      gateway: `http://127.0.0.1:${server.address().port}`, left: 120, top: 120,
      topmost: native, autostart: false, keepAlive: false, updateMode: 'never', quietMotion: true,
    }));
    await app.whenReady();
    if (native) {
      back = new BrowserWindow({ x: 80, y: 80, width: 1000, height: 700, frame: false,
        show: false, focusable: false, skipTaskbar: true, alwaysOnTop: true });
      await back.loadURL('data:text/html,<body style="background:lightslategray"><script>window.__pointerDowns=0;document.addEventListener("pointerdown",()=>window.__pointerDowns++,true)</script>');
      back.showInactive();
    }
    app.on('browser-window-created', (_event, created) => {
      win = created;
      if (!native) {
        win.showInactive = () => { visible = true; win.emit('show'); };
        win.isVisible = () => visible;
      }
      win.focus = () => {};
      win.blur = () => win.emit('blur');
      const ignore = win.setIgnoreMouseEvents.bind(win);
      win.setIgnoreMouseEvents = (value, options) => {
        ignored = value; ignoreCalls.push(value); ignore(value, options);
      };
      win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
    });
    ipcMain.once('busy:ready', () => setTimeout(run, 250));
    screen.getCursorScreenPoint = () => cursor;
    const filename = path.join(root, 'src/main.js');
    const main = new Module(filename, module);
    main.filename = filename;
    main.paths = Module._nodeModulePaths(path.dirname(filename));
    main.require = function(id) {
      if (id === './window-material.cjs' && fallback) return { windowMaterial: () => ({
        kind: 'none', options: { transparent: true, roundedCorners: false, hasShadow: false },
      }) };
      if (id === 'electron') return { ...require('electron'), BrowserWindow: class extends BrowserWindow {
        constructor(options) { super({ ...options, webPreferences: { ...options.webPreferences, offscreen: !native } }); }
      } };
      return Module.prototype.require.call(this, id);
    };
    main._compile(fs.readFileSync(filename, 'utf8'), filename);
  } catch (error) { finish(error); }
});
setTimeout(() => finish(new Error('pointer input check timed out')), 30000).unref();
