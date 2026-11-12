'use strict';

// PostMessage/sendInputEvent bypass the Windows input route and can pass while
// a hidden Chrome_RenderWidgetHostHWND eats real clicks. Use SendInput against
// this fixture only, restore the cursor, and exercise the production handlers.
const { app, ipcMain, screen } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const Module = require('node:module');
const { windowsPointerState } = require('../../src/pointer-diagnostic.cjs');

assert.equal(process.platform, 'win32');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'artifacts', 'pointer-visibility');
const profile = path.join(output, `profile-${process.pid}`);
fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
app.setPath('sessionData', profile);
app.getVersion = () => JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
// The shipped entry sets this before app.ready. It does not prevent the
// explicit hide/show path that used to strand the input child.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

const k = require('koffi');
const user = k.load('user32.dll');
const Point = k.struct({ x: 'int32', y: 'int32' });
const at = user.func('__stdcall', 'WindowFromPoint', 'uintptr_t', [Point]);
const ancestor = user.func('uintptr_t __stdcall GetAncestor(uintptr_t,uint32)');
const find = user.func('uintptr_t __stdcall FindWindowExW(uintptr_t,uintptr_t,str16,str16)');
const visible = user.func('int __stdcall IsWindowVisible(uintptr_t)');
const move = user.func('int __stdcall SetCursorPos(int32,int32)');
const getCursor = user.func('__stdcall', 'GetCursorPos', 'int', [k.out(k.pointer(Point))]);
const keyState = user.func('int16 __stdcall GetAsyncKeyState(int32)');
const inject = user.func('uint32 __stdcall SendInput(uint32,void *,int32)');
const metric = user.func('int __stdcall GetSystemMetrics(int32)');
const originalCursor = {};
assert.ok(getCursor(originalCursor));
assert.equal(keyState(1) & 0x8000, 0, 'do not run while the user holds the mouse');

const checks = [], samples = [], rendererErrors = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let win, finished = false, mouseHeld = false, dragStarts = 0;
const hwnd = () => win.getNativeWindowHandle().readBigUInt64LE();
const js = source => win.webContents.executeJavaScript(source);
const record = name => { checks.push(name); console.log('PASS', name); };

function button(down) {
  // INPUT is 40 bytes on Windows x64; MOUSEINPUT.dwFlags is at byte 20.
  const input = Buffer.alloc(40);
  input.writeUInt32LE(down ? 2 : 4, 20);
  assert.equal(inject(1, input, input.length), 1, 'Windows must accept the fixture mouse input');
  mouseHeld = down;
}

async function pointFor(selector) {
  const point = await js(`(() => {
    const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, width: r.width, height: r.height };
  })()`);
  assert.ok(point.width > 0 && point.height > 0, `${selector} must be visible`);
  const bounds = win.getBounds();
  return screen.dipToScreenPoint({ x: Math.round(bounds.x + point.x), y: Math.round(bounds.y + point.y) });
}

async function moveTo(point) {
  assert.equal(BigInt(ancestor(at(point), 2)), hwnd(), 'only inject input over this test window');
  assert.ok(move(point.x, point.y));
  await sleep(70);
}

async function click(selector) {
  const point = await pointFor(selector);
  await moveTo(point);
  // Submit both transitions together so physical mouse motion between two
  // asynchronous calls cannot turn a click into a drag or hit another control.
  const x = Math.round((point.x - metric(76)) * 65535 / (metric(78) - 1));
  const y = Math.round((point.y - metric(77)) * 65535 / (metric(79) - 1));
  const input = Buffer.alloc(80);
  for (const [offset, flags] of [[0, 2], [40, 4]]) {
    input.writeInt32LE(x, offset + 8);
    input.writeInt32LE(y, offset + 12);
    input.writeUInt32LE(0xc001 | flags, offset + 20); // absolute virtual-desktop move + button
  }
  assert.equal(inject(2, input, 40), 2);
  await sleep(120);
}

function sample(label) {
  const child = find(hwnd(), 0, 'Chrome_RenderWidgetHostHWND', null);
  const state = { label, visible: win.isVisible(), child: String(child), childVisible: Boolean(child && visible(child)) };
  const diagnostic = windowsPointerState(win);
  assert.equal(diagnostic.rendererVisible, child ? state.childVisible : null, 'diagnostics must report the input child separately');
  samples.push(state);
  return state;
}

async function menu(label) {
  const compact = await js('document.body.classList.contains("compact")');
  const selector = compact ? '#compactMenu' : '#quickMenuToggle';
  await click(selector);
  assert.equal(await js('!document.getElementById("quickMenu").hidden'), true, `${label}: real click must open the menu`);
  const closeSelector = await js('document.body.classList.contains("compact")') ? '#compactMenu' : '#quickMenuToggle';
  await click(closeSelector);
  assert.equal(await js('document.getElementById("quickMenu").hidden'), true, `${label}: real click must close the menu`);
  record(`${label}: real mouse opens and closes the menu`);
}

async function drag(label) {
  const compact = await js('document.body.classList.contains("compact")');
  const before = win.getBounds();
  const point = await pointFor(compact ? '#compactDragBar' : '#dragBar');
  await moveTo(point);
  const starts = dragStarts;
  button(true);
  await sleep(240);
  assert.equal(dragStarts, starts + 1, `${label}: real long press must reach the drag handler`);
  assert.ok(move(point.x + 40, point.y + 30));
  await sleep(110);
  const moved = win.getBounds();
  assert.ok(moved.x > before.x + 5 && moved.y > before.y + 5, `${label}: the window must follow the mouse`);
  button(false);
  await sleep(100);
  const released = win.getBounds();
  assert.ok(move(point.x + 65, point.y + 45));
  await sleep(100);
  assert.deepEqual(win.getBounds(), released, `${label}: release must stop dragging`);
  win.setBounds(before, false);
  await sleep(100);
  record(`${label}: real long press, movement and release work`);
}

async function hideAndShow(label) {
  const compact = await js('document.body.classList.contains("compact")');
  await click(compact ? '#compactMenu' : '#quickMenuToggle');
  await click('[data-menu-action="hide"]');
  assert.equal(win.isVisible(), false, `${label}: the production menu must hide the card`);
  await sleep(100);
  sample(`${label}: hidden`);
  app.emit('second-instance'); // The installed launcher reaches showWindow this way.
  await sleep(150);
  sample(`${label}: shown`);
}

function finish(error) {
  if (finished) return;
  finished = true;
  try { if (mouseHeld) button(false); }
  catch (cleanupError) { error ||= cleanupError; }
  finally { move(originalCursor.x, originalCursor.y); }
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({
    ok: !error, electron: process.versions.electron, chrome: process.versions.chrome,
    checks, samples, rendererErrors, error: error?.stack,
  }, null, 2));
  if (error) console.error(error.stack);
  server.closeAllConnections();
  server.close();
  win?.destroy();
  app.exit(error ? 1 : 0);
}

async function run() {
  try {
    sample('startup');
    await menu('startup');
    await hideAndShow('normal');
    // Assert the user's symptom before the implementation-level child probe.
    await menu('normal after hide/show');
    assert.equal(sample('normal input').childVisible, true);
    await drag('normal after hide/show');
    await js('window.busy.toggleCompact()');
    await sleep(150);
    await hideAndShow('compact');
    await menu('compact after hide/show');
    assert.equal(sample('compact input').childVisible, true);
    await drag('compact after hide/show');
    await js('window.busy.toggleCompact()');
    await sleep(150);
    for (let cycle = 0; cycle < 5; cycle++) {
      win.hide();
      await sleep(40);
      app.emit('second-instance');
      await sleep(80);
      assert.equal(sample(`repeat ${cycle}`).childVisible, true, 'each show must restore native input');
    }
    await menu('after five more hide/show cycles');
    await drag('after five more hide/show cycles');
    assert.equal(rendererErrors.length, 0, rendererErrors.join('\n'));
    finish();
  } catch (error) { finish(error); }
}

const server = http.createServer((request, response) => {
  const data = request.url.includes('/usage')
    ? { period: 'today', input: 0, output: 0, calls: 0 }
    : { pid: 1, seq: 1, totals: { requests: 0 }, routes: [] };
  setTimeout(() => {
    if (response.destroyed) return;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(data));
  }, request.url.includes('wait') ? 100 : 0);
});
server.listen(0, '127.0.0.1', async () => {
  try {
    fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({
      gateway: `http://127.0.0.1:${server.address().port}`, left: 80, top: 80,
      topmost: true, opacity: 0, autostart: false, keepAlive: false, updateMode: 'never',
    }));
    await app.whenReady();
    app.on('browser-window-created', (_event, created) => {
      win = created;
      win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) rendererErrors.push(message); });
    });
    ipcMain.on('busy:drag-start', () => { dragStarts++; });
    ipcMain.once('busy:ready', () => setTimeout(run, 200));
    const filename = path.join(root, 'src/main.js');
    const main = new Module(filename, module);
    main.filename = filename;
    main.paths = Module._nodeModulePaths(path.dirname(filename));
    main._compile(fs.readFileSync(filename, 'utf8'), filename);
  } catch (error) { finish(error); }
});
setTimeout(() => finish(new Error('native pointer visibility test timed out')), 30000).unref();
