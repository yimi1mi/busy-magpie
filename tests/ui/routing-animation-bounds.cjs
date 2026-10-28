const { app, BrowserWindow, ipcMain, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const Module = require('node:module');


const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'artifacts', 'routing-animation-bounds');
const profile = path.join(output, 'profile-' + process.pid);
fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
app.setPath('sessionData', profile);
app.getVersion = () => JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const checks = [], failures = [], samples = [], errors = [];
let win, finished = false;
const server = http.createServer((req, res) => {
  const data = req.url.includes('/usage')
    ? { period: 'today', calls: 0, input: 0, output: 0 }
    : { pid: 12345, seq: 1, totals: { requests: 0 }, routes: [] };
  setTimeout(() => {
    if (res.destroyed) return;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }, req.url.includes('wait=') ? 100 : 0);
});

app.on('browser-window-created', (_event, created) => {
  win = created;
  // Keep the real native compositor without covering the user's desktop or taking focus.
  win.setOpacity(0.01);
  win.focus = () => {};
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3) errors.push(message);
  });
});
ipcMain.once('busy:ready', () => setTimeout(run, 200));
const js = code => win.webContents.executeJavaScript(code);
function check(name, passed, detail) {
  if (passed) { checks.push(name); console.log('PASS', name); }
  else { failures.push({ name, detail }); console.error('FAIL', name); }
}
async function finish(error) {
  if (finished) return;
  finished = true;
  if (error) failures.push({ name: 'run', detail: error.stack });
  if (win && !win.isDestroyed()) {
    fs.writeFileSync(path.join(output, failures.length ? 'failed.png' : 'passed.png'),
      (await win.webContents.capturePage()).toPNG());
  }
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({
    ok: !failures.length, checks, failures, samples, rendererErrors: errors,
    electron: process.versions.electron,
  }, null, 2));
  server.closeAllConnections(); server.close();
  if (win && !win.isDestroyed()) win.destroy();
  app.exit(failures.length ? 1 : 0);
}
const rectCode = `r=>({x:r.x,y:r.y,width:r.width,height:r.height})`;
async function geometry(name) {
  const value = await js(`(()=>{
    const rect=${rectCode}, canvas=document.getElementById('stageCanvas'), c=canvas.getBoundingClientRect();
    const hub=document.getElementById(document.body.classList.contains('multi')?'fanHub':'hub');
    const inside=r=>[r.x,r.y,r.width,r.height].every(Number.isFinite)&&r.right>=c.left&&r.left<=c.right&&r.bottom>=c.top&&r.top<=c.bottom;
    const nodes=[...document.querySelectorAll('body.multi #fanAgents>.node,body.multi #fanAccounts>.node')];
    const birds=[...document.querySelectorAll('.flying-bird')];
    return {hub:rect(hub.getBoundingClientRect()),hubInside:inside(hub.getBoundingClientRect()),
      canvas:rect(c),scroll:{width:canvas.scrollWidth,height:canvas.scrollHeight},
      nodes:nodes.map(n=>({key:n.dataset.layoutKey,rect:rect(n.getBoundingClientRect()),inside:inside(n.getBoundingClientRect())})),
      birds:birds.map(b=>({id:b.dataset.requestId,phase:b.dataset.phase,transform:b.getAttribute('transform'),rect:rect(b.getBoundingClientRect()),inside:inside(b.getBoundingClientRect())})),
      ghosts:[...document.querySelectorAll('.routing-ghost')].map(g=>({position:getComputedStyle(g).position,rect:rect(g.getBoundingClientRect())}))};
  })()`);
  samples.push({ name, ...value });
  return value;
}
async function layoutTime(mode) {
  return js(`(()=>{const list=document.getAnimations().filter(a=>a.effect.getKeyframes().some(k=>k.translate));
    for(const a of list){${mode === 'pause' ? 'a.pause();a.currentTime=0;' : 'a.finish();'}}return list.length;})()`);
}
async function run() {
  try {
    const send = win.webContents.send.bind(win.webContents);
    win.webContents.send = (channel, ...args) => ['magpie:trace', 'magpie:connection'].includes(channel) ? undefined : send(channel, ...args);
    let seq = 10, nextId = 100;
    const route = id => ({ id, session: 'session-' + id, agent: 'codex', time: new Date().toISOString(),
      model: 'sample-model', provider: 'openai', done: false,
      order: [{ id: 'a', kind: 'account', who: 'sample@example.com' }], tries: [{ id: 'a', done: false }] });
    const update = async (routes, delay = 20, requests = seq) => {
      send('magpie:trace', { pid: 12345, seq: ++seq, totals: { requests }, routes });
      if (delay) await sleep(delay);
    };
    const a = route(1), b = route(2);
    await update([a]); await sleep(600); await layoutTime('finish');
    const before = (await geometry('single baseline')).hub;
    await update([a, b]); await layoutTime('pause');
    for (let i = 0; i < 20; i++) { await update([a, b], 5); await layoutTime('pause'); }
    const held = (await geometry('repeated interrupted hub animations')).hub;
    check('rebuilding a paused hub transition preserves its displayed bounds',
      Math.max(...['x', 'y', 'width', 'height'].map(k => Math.abs(before[k] - held[k]))) < 1,
      { before, held });
    await layoutTime('finish'); await sleep(100);

    await update(Array.from({ length: 5 }, () => route(++nextId))); await sleep(100);
    await update([route(++nextId)], 5);
    const departing = await geometry('departing fan cards');
    check('departing fan cards stay out of normal document flow',
      departing.ghosts.length > 0 && departing.ghosts.every(g => g.position === 'absolute'), departing);
    check('departing cards do not enlarge the fixed stage',
      departing.scroll.width <= 601 && departing.scroll.height <= 401, departing.scroll);
    await layoutTime('finish'); await sleep(100);

    for (let i = 0; i < 400; i++) {
      await update(Array.from({ length: 1 + i % 5 }, () => route(++nextId)), 8);
      if (i % 50 === 49) {
        await sleep(60);
        const current = await geometry('burst ' + i);
        check('hub and active routing cards stay in the canvas at burst ' + i,
          current.hubInside && current.nodes.every(n => n.inside), current);
        check('moving flights stay on the visible routing stage at burst ' + i,
          current.birds.length === 5 && current.birds.every(b => b.inside && !/NaN|Infinity/.test(b.transform || '')), current.birds);
        check('ghost cards remain absolutely positioned at burst ' + i,
          current.ghosts.every(g => g.position === 'absolute'), current.ghosts);
      }
    }
    await sleep(800);
    const final = await geometry('five requests after the burst');
    const overflow = final.nodes.filter(n => n.key.endsWith(':overflow'));
    check('overflow anchors stay in the canvas after repeated departure and return',
      overflow.length === 2 && overflow.every(n => n.inside), overflow);
    check('all five flights, including both folded requests, stay in the canvas',
      final.birds.length === 5 && final.birds.every(b => b.inside && !/NaN|Infinity/.test(b.transform || '')), final.birds);
    await sleep(800);
    check('departing card ghosts are removed when their transitions finish',
      await js('document.querySelectorAll(".routing-ghost").length') === 0);

    const pathBounds = await js(`(()=>{const p=document.getElementById('fanBirdPath'),r=p.getBoundingClientRect();return {x:Math.floor(r.x),y:Math.floor(r.y),width:Math.ceil(r.width)+1,height:Math.ceil(r.height)+1};})()`);
    const bitmap = (await win.webContents.capturePage(pathBounds)).toBitmap();
    let ink = 0;
    for (let i = 0; i < bitmap.length; i += 4) {
      const colors = [bitmap[i], bitmap[i + 1], bitmap[i + 2]];
      if (bitmap[i + 3] > 100 && Math.min(...colors) > 195 && Math.max(...colors) - Math.min(...colors) < 65) ink++;
    }
    check('central bird remains present in the rendered pixels', ink > 20, { ink, pathBounds });

    await js(`window.originalRAF=requestAnimationFrame;window.requestAnimationFrame=cb=>{const queued=performance.now();return originalRAF(t=>cb(Math.min(t,queued-150)));};true;`);
    await update([route(++nextId)], 50, 100000);
    const renderedCount = await js('Number(document.getElementById("statRequests").dataset.rendered)');
    await js('window.requestAnimationFrame=window.originalRAF;true;');
    check('an earlier frame timestamp cannot animate a positive count below zero', renderedCount >= 0, { renderedCount });
    check('renderer completes without console errors', errors.length === 0, errors);
    await sleep(600);
    await finish();
  } catch (error) { await finish(error); }
}
server.listen(0, '127.0.0.1', async () => {
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({
    gateway: `http://127.0.0.1:${server.address().port}`, topmost: false, autostart: false,
    keepAlive: false, updateMode: 'never', quietMotion: false, left: 40, top: 40,
  }));
  await app.whenReady();
  screen.getCursorScreenPoint = () => ({ x: -10000, y: -10000 });
  const filename = path.join(root, 'src/main.js'), main = new Module(filename, module);
  main.filename = filename; main.paths = Module._nodeModulePaths(path.dirname(filename));
  main._compile(fs.readFileSync(filename, 'utf8'), filename);
});
setTimeout(() => finish(new Error('routing animation bounds check timed out')), 60000).unref();

