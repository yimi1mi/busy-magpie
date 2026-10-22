const { app, BrowserWindow, ipcMain, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const Module = require('node:module');

const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'artifacts', 'request-modes');
const profile = path.join(output, 'profile-' + process.pid);
fs.mkdirSync(profile, { recursive: true });
fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ running: true }));
app.setPath('userData', profile);
app.setPath('sessionData', profile);
app.getVersion = () => JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
app.disableHardwareAcceleration();

let win, visible = false, finished = false, rendererReady = false;
const checks = [], errors = [], screenshots = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const record = name => { checks.push(name); console.log('PASS', name); };
const server = http.createServer((req, res) => {
  const period = new URL(req.url, 'http://127.0.0.1').searchParams.get('period') || '30d';
  const data = req.url.includes('/usage')
    ? { period, calls: 40, input: 120000, output: 40000, cache_read: 400000 }
    : { seq: 1, pid: 12345, totals: { requests: 0, rerouted: 0, errors: 0 }, routes: [] };
  setTimeout(() => {
    if (res.destroyed) return;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }, req.url.includes('wait=') ? 100 : 0);
});

app.on('browser-window-created', (_event, created) => {
  win = created;
  win.showInactive = () => { visible = true; win.emit('show'); };
  win.isVisible = () => visible;
  win.hide = () => { visible = false; win.emit('hide'); };
  win.focus = () => {};
  win.blur = () => win.emit('blur');
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3) errors.push(message);
  });
});
ipcMain.once('busy:ready', () => setTimeout(run, 200));
const js = code => win.webContents.executeJavaScript(code);

async function cards() {
  return js(`(() => {
    const rect = node => {
      if (!node) return null;
      const r = node.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    };
    const nodes = document.body.classList.contains('multi')
      ? [...document.querySelectorAll('#fanAgents > .node')]
      : [document.getElementById('agentNode')];
    return nodes.map(node => {
      const modes = node.querySelector('.request-modes');
      const speed = modes?.querySelector('.mode-speed');
      const effort = modes?.querySelector('.mode-effort');
      const context = node.querySelector('.model');
      const name = node.querySelector('.agent-line, .agent-title');
      return {
        key: node.dataset.layoutKey, id: node.dataset.id,
        count: modes?.querySelectorAll('.mode-icon').length,
        visible: modes && !modes.hidden && getComputedStyle(modes).display !== 'none',
        titled: Boolean(modes?.closest('[title]') || modes?.querySelector('[title], title')),
        speed: speed?.dataset.mode, effort: effort?.dataset.effort,
        steps: effort?.querySelectorAll('.effort-step').length,
        lit: effort?.querySelectorAll('.effort-step.on').length,
        unknown: effort?.querySelector('.mode-unknown')?.textContent || '',
        speedLabel: speed?.getAttribute('aria-label'), effortLabel: effort?.getAttribute('aria-label'),
        card: rect(node), modes: rect(modes), name: rect(name),
        context: context && getComputedStyle(context).display !== 'none' ? rect(context) : null,
        icons: [...(modes?.querySelectorAll('.mode-icon') || [])].map(rect),
      };
    });
  })()`);
}

function assertModes(card, { speed, effort, lit }) {
  assert.ok(card, 'expected agent card exists');
  const hasSpeed = speed !== 'unknown', hasEffort = effort !== 'unknown';
  const count = Number(hasSpeed) + Number(hasEffort);
  assert.equal(card.count, count, JSON.stringify(card));
  assert.equal(card.visible, count > 0, JSON.stringify(card));
  assert.equal(card.titled, false, 'mode symbols must not depend on hover titles');
  assert.equal(card.speed, hasSpeed ? speed : undefined, JSON.stringify(card));
  assert.equal(card.effort, hasEffort ? effort : undefined, JSON.stringify(card));
  assert.equal(card.steps, hasEffort ? 6 : undefined);
  assert.equal(card.lit, hasEffort ? lit : undefined, JSON.stringify(card));
  assert.equal(card.unknown, '', 'missing modes must not produce question-mark placeholders');
  if (hasSpeed) assert.ok(card.speedLabel, 'speed symbols retain an accessible label');
  if (hasEffort) assert.ok(card.effortLabel, 'effort symbols retain an accessible label');
}

function assertFits(card) {
  if (!card.visible) {
    assert.equal(card.count, 0, 'hidden mode rows contain no symbols');
    return;
  }
  const within = box => box.left >= card.card.left - 0.5 && box.right <= card.card.right + 0.5
    && box.top >= card.card.top - 0.5 && box.bottom <= card.card.bottom + 0.5;
  assert.ok(within(card.modes), 'mode row must fit inside card: ' + JSON.stringify(card));
  assert.ok(card.icons.every(within), 'both mode symbols must fit inside card: ' + JSON.stringify(card));
  if (card.context) assert.ok(card.context.bottom <= card.modes.top + 0.5,
    'visible context line must not overlap modes: ' + JSON.stringify(card));
  if (card.name) assert.ok(card.name.bottom <= card.modes.top + 0.5,
    'agent name must not overlap modes: ' + JSON.stringify(card));
}

async function capture(name) {
  const file = path.join(output, name + '.png');
  fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG());
  screenshots.push(file);
}

async function finish(error) {
  if (finished) return;
  finished = true;
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({
    ok: !error, checks, screenshots, rendererErrors: errors, error: error?.stack,
    rendererReady, url: win?.webContents.getURL(), pid: process.pid,
  }, null, 2));
  if (error && rendererReady && win && !win.isDestroyed()) {
    try { await capture('failed'); } catch {}
  }
  if (error) console.error(error.stack || error);
  server.close();
  win?.destroy();
  app.exit(error ? 1 : 0);
}

async function run() {
  rendererReady = true;
  try {
    const send = win.webContents.send.bind(win.webContents);
    win.webContents.send = (channel, ...args) => ['magpie:trace', 'magpie:connection'].includes(channel)
      ? undefined : send(channel, ...args);
    const now = Date.now();
    let seq = 20;
    const row = (id, extra = {}) => ({
      id, session: 'chat', folder: 'workspace/request-modes', agent: 'codex',
      time: new Date(now - 5000 + id * 10).toISOString(), model: 'gpt-6-astra', provider: 'openai',
      done: false, order: [{ id: 'test-account', kind: 'account', icon: 'openai', provider: 'openai' }],
      tries: [{ id: 'test-account', done: false }], ...extra,
    });
    const feed = async routes => {
      send('magpie:connection', { online: true, detail: 'test fixture' });
      send('magpie:trace', { pid: 12345, seq: ++seq, now: new Date(now).toISOString(),
        totals: { requests: routes.length, rerouted: 0, errors: 0 }, routes });
      await sleep(180);
      return cards();
    };

    const ordinary = row(100, { tier: 'priority', effort: 'xhigh' });
    let shown = await feed([ordinary]);
    assert.equal(shown.length, 1);
    assertModes(shown[0], { speed: 'fast', effort: 'xhigh', lit: 5 });
    assertFits(shown[0]);
    await capture('single-fast-xhigh');
    record('Codex priority and xhigh render two visible symbols with five effort steps and no hover title');

    const guardian = row(101, { kind: 'guardian', effort: 'low' });
    shown = await feed([ordinary, guardian]);
    assert.equal(shown.length, 1);
    assertModes(shown[0], { speed: 'fast', effort: 'xhigh', lit: 5 });
    record('a newer guardian request cannot overwrite the conversation mode');

    shown = await feed([ordinary, { ...guardian, session: 'helper' }]);
    assert.equal(shown.length, 2);
    assertModes(shown.find(card => card.key === 'agent:codex|chat'), { speed: 'fast', effort: 'xhigh', lit: 5 });
    assertModes(shown.find(card => card.key === 'agent:codex|helper'), { speed: 'unknown', effort: 'unknown', lit: 0 });
    record('an auxiliary-only session hides its mode row without borrowing another session mode or showing placeholders');

    const completed = { ...ordinary, done: true, status: 200, ms: 1000,
      time: new Date(now - 60000).toISOString(), tries: [{ id: 'test-account', done: true, status: 200 }] };
    shown = await feed([completed, guardian]);
    assert.equal(shown.length, 1);
    assert.equal(shown[0].id, undefined, 'only the guardian remains staged, so the single-card view is used');
    assertModes(shown[0], { speed: 'fast', effort: 'xhigh', lit: 5 });
    record('the complete trace retains the conversation mode after its ordinary request leaves staged routes');

    shown = await feed([row(200, { session: '', effort: 'high' }), row(201, { session: '', tier: 'priority' })]);
    assert.equal(shown.length, 2);
    assertModes(shown.find(card => card.id === '200'), { speed: 'unknown', effort: 'high', lit: 4 });
    assertModes(shown.find(card => card.id === '201'), { speed: 'fast', effort: 'unknown', lit: 0 });
    record('requests without a session keep one symbol for their own known field without borrowing another request mode');

    const claude = { agent: 'claude', provider: 'anthropic', model: 'claude-opus', effort: 'high',
      order: [{ id: 'test-account', kind: 'account', icon: 'anthropic', provider: 'anthropic' }] };
    shown = await feed([row(300, { ...claude, tier: 'priority', session: 'claude-priority' }),
      row(301, { ...claude, tier: 'fast', session: 'claude-fast' })]);
    assertModes(shown.find(card => card.id === '300'), { speed: 'other', effort: 'high', lit: 4 });
    assertModes(shown.find(card => card.id === '301'), { speed: 'fast', effort: 'high', lit: 4 });
    await capture('claude-priority-and-fast');
    record('Claude priority remains distinct while its normalized speed fast lights the Fast symbol');

    const levels = [
      { speed: 'fast', effort: 'low', lit: 2 },
      { speed: 'fast', effort: 'high', lit: 4 },
      { speed: 'fast', effort: 'ultra', lit: 6 },
      { speed: 'unknown', effort: 'unknown', lit: 0 },
    ];
    for (const count of [2, 3, 4]) {
      shown = await feed(levels.slice(0, count).map((level, index) => row(400 + index, {
        session: 'layout-' + index,
        ...(level.speed === 'fast' ? { tier: 'priority' } : {}),
        ...(level.effort !== 'unknown' ? { effort: level.effort } : {}),
      })));
      assert.equal(shown.length, count);
      const contextGaps = [];
      for (let index = 0; index < count; index++) {
        const card = shown.find(item => item.id === String(400 + index));
        assertModes(card, levels[index]);
        assertFits(card);
        if (count === 2) {
          assert.ok(card.context, 'two-group cards keep the context line visible');
          const gap = Math.min(...card.icons.map(icon => icon.top)) - card.context.bottom;
          assert.ok(gap >= 3, 'mode symbols need at least 3px below context: ' + JSON.stringify({ gap, card }));
          contextGaps.push(gap);
        }
      }
      await capture('groups-' + count);
      record(count === 2
        ? `2 groups keep mode symbols at least 3px below visible context (measured ${contextGaps.map(gap => gap.toFixed(2)).join(', ')}px)`
        : `${count} groups preserve correct effort levels and fit both symbols without overlapping context`);
    }
    assert.equal(errors.length, 0, errors.join('\n'));
    await finish();
  } catch (error) { await finish(error); }
}

server.listen(0, '127.0.0.1', async () => {
  const gateway = `http://127.0.0.1:${server.address().port}`;
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ gateway, topmost: false,
    hotkeyOn: false, autostart: false, keepAlive: false, quietMotion: true, updateMode: 'never',
    guideVersion: 1, usagePeriod: '30d', left: 40, top: 40 }));
  await app.whenReady();
  screen.getCursorScreenPoint = () => ({ x: -10000, y: -10000 });
  const filename = path.join(root, 'src/main.js');
  const mainModule = new Module(filename, module);
  mainModule.filename = filename;
  mainModule.paths = Module._nodeModulePaths(path.dirname(filename));
  mainModule.require = function (id) {
    if (id === './windows-blur.cjs') return { attachBlur: () => ({ refresh() {} }) };
    if (id === 'electron') return { ...require('electron'), BrowserWindow: class extends BrowserWindow {
      constructor(options) {
        const { backgroundMaterial, ...offscreenOptions } = options;
        super({ ...offscreenOptions, show: false, transparent: true, roundedCorners: false, hasShadow: false,
          webPreferences: { ...options.webPreferences, offscreen: true } });
      }
    } };
    return Module.prototype.require.call(this, id);
  };
  mainModule._compile(fs.readFileSync(filename, 'utf8'), filename);
});
setTimeout(() => finish(new Error('UI check timed out')), 30000).unref();
