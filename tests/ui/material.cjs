const { app, BrowserWindow, ipcMain, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const Module = require('node:module');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'artifacts', 'material');
const profile = path.join(output, 'profile-' + process.pid);
fs.mkdirSync(profile, { recursive: true });
fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({running:true}));
app.setPath('userData', profile);
app.setPath('sessionData', profile);
app.getVersion = () => JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
app.disableHardwareAcceleration();
let win, visible = false, ignored = true, cursor = { x: -10000, y: -10000 };
let hitAreas, dragStarted = 0, dragCalls = 0, usageSwitches = 0;
let materialRefreshes = 0;
const checks = [];
const errors = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const record = name => { checks.push(name); console.log('PASS', name); };
const server = http.createServer((req, res) => {
  const period = new URL(req.url, 'http://127.0.0.1').searchParams.get('period') || '30d';
  const data = req.url.includes('/usage')
    ? {period, calls:301, input:14120000, output:1650000, cache_read:520000000}
    : {seq:1,pid:12345,totals:{requests:301,rerouted:2,errors:1},routes:[{
      id:1,time:new Date().toISOString(),agent:'codex',model:'gpt-6-astra',provider:'openai',done:true,status:200,ms:3100,
      order:[{id:'test',name:'OpenAI',kind:'account',who:'alex@example.com',icon:'openai',model:'gpt-6-astra'}],
      tries:[{id:'test',model:'gpt-6-astra',done:true,status:200}]
    }]};
  setTimeout(() => { if(!res.destroyed){ res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify(data)); } }, req.url.includes('wait=') ? 100 : 0);
});
app.on('browser-window-created', (_event, created) => {
  win = created;
  // Exercise main + preload + renderer together without showing a second
  // desktop widget or moving focus away from the user's current application.
  win.showInactive = () => { visible = true; win.emit('show'); };
  win.isVisible = () => visible;
  win.hide = () => { visible = false; win.emit('hide'); };
  win.focus = () => {};
  win.blur = () => win.emit('blur');
  const ignore = win.setIgnoreMouseEvents.bind(win);
  win.setIgnoreMouseEvents = (value, options) => { ignored = value; ignore(value, options); };
  win.webContents.on('did-fail-load',(_event,code,description)=>errors.push(description));
  win.webContents.on('console-message', (_event, level, message) => { if(level >= 3) errors.push(message); });
});
ipcMain.on('busy:hit-areas', (_event, data) => { hitAreas = data; });
ipcMain.on('busy:drag-start', () => { dragStarted = performance.now(); dragCalls++; });
// Observe settings without replacing any production IPC handlers.
ipcMain.on('busy:ready', () => setTimeout(run, 200));
async function js(code) { return win.webContents.executeJavaScript(code); }
async function click(id) { await js(`document.getElementById(${JSON.stringify(id)}).click()`); await sleep(60); }
async function menuAction(action) {
  await js(`document.querySelector('[data-menu-action="${action}"]').click()`); await sleep(80);
}
async function openMenu() { cursor={x:-10000,y:-10000}; await click('quickMenuToggle'); assert.equal(await js('document.getElementById("quickMenu").hidden'), false); }
async function run() {
 try {
  assert.equal(await js('document.querySelector("#firstRunMask, [class*=first-run], .guide-steps, .guide-uninstall")'),null);
  assert.equal(await js('Object.keys(window.busy).some(key=>/firstRun|openInstallDir/i.test(key))'),false);
  assert.equal(await js('window.busy.bootstrap().then(x=>Object.hasOwn(x,"firstRun"))'),false);
  assert.equal(ipcMain.listenerCount('busy:first-run-dismiss'),0);
  assert.equal(ipcMain.listenerCount('busy:open-install-dir'),0);
  assert.equal(ignored,true);
  record('a fresh profile starts directly in pointer pass-through mode with no guide or guide API');
  const material=await js('window.busy.bootstrap().then(x=>x.settings.backgroundMaterial)');
  assert.equal(material,'blur');
  assert.equal(await js('document.body.classList.contains("native-material")'),true);
  const bounds=await js('(()=>{const r=document.getElementById("stageArea").getBoundingClientRect();return {w:r.width,h:r.height,x:r.x,y:r.y};})()');
  assert.deepEqual(bounds,{w:600,h:400,x:16,y:16});
  assert.equal(await js('getComputedStyle(document.querySelector(".card")).borderRadius'),'22px');
  record('native background preserves the content canvas and hit coordinates');
  const originalBounds=win.getBounds();
  cursor={x:originalBounds.x+100,y:originalBounds.y+20};
  await sleep(100);
  await js('document.getElementById("dragBar").dispatchEvent(new PointerEvent("pointerdown",{bubbles:true,button:0,buttons:1,pointerId:1,clientX:100,clientY:20}))');
  await sleep(220);
  assert.equal(dragCalls,1);
  cursor={x:cursor.x+40,y:cursor.y+30};
  await sleep(80);
  assert.deepEqual(win.getPosition(),[originalBounds.x+40,originalBounds.y+30]);
  await js('window.dispatchEvent(new PointerEvent("pointerup",{bubbles:true,button:0,buttons:0,pointerId:1}))');
  await sleep(80);
  const releasedPosition=win.getPosition();
  cursor={x:-10000,y:-10000};
  await sleep(100);
  assert.deepEqual(win.getPosition(),releasedPosition);
  assert.equal(ignored,true);
  win.setBounds(originalBounds);
  record('a fresh profile allows long-press dragging and stops moving when released');
  const stored=JSON.parse(fs.readFileSync(path.join(profile,'settings.json'),'utf8')).opacity??1;
  const before=await js('getComputedStyle(document.documentElement).getPropertyValue("--surface-alpha")');
  await openMenu();
  assert.equal(await js('document.querySelector("[data-menu-action=history]")'),null);
  assert.equal(await js('document.getElementById("historyView")'),null);
  assert.equal(await js('document.getElementById("lanesMore")'),null);
  assert.equal(await js('document.querySelector("[data-menu-action=models]")'),null);
  assert.equal(await js('document.getElementById("modelsView")'),null);
  assert.equal(await js('Boolean(document.querySelector(".story"))'),true);
  const menuColor=await js('getComputedStyle(document.getElementById("quickMenu")).backgroundColor');
  assert.ok(Number(menuColor.match(/[\d.]+/g).at(-1))>=0.9,menuColor);
  record('the menu covers underlying card text while retaining its own clear labels');
  const iconColor=await js('getComputedStyle(document.querySelector(".agent-icon .brand-mark")).color');
  assert.equal(iconColor,'rgb(241, 240, 245)');
  record('monochrome agent artwork keeps its own color instead of taking the route color');
  await menuAction('settings');
  assert.equal(await js('document.getElementById("settingsOpacity").value'),'30');
  const settingsText = await js(`(() => {
    const label=document.querySelector('.settings-opacity b'),range=document.createRange();
    range.selectNodeContents(label);
    return {opacityLabel:label.textContent,lines:new Set([...range.getClientRects()].map(r=>Math.round(r.top))).size,
      helperCount:document.querySelectorAll('#settingsForm small').length};
  })()`);
  assert.equal(settingsText.lines,1,JSON.stringify(settingsText));
  assert.equal(settingsText.helperCount,0,JSON.stringify(settingsText));
  record('settings labels fit one line and contain no secondary helper text');
  assert.equal(await js('document.querySelector("#settingsHotkey, #settingsHotkeyOn, #hotkeyRecord, #hotkeyStatus")'),null);
  assert.equal(await js('document.getElementById("settingsTab-connection").textContent'),'连接');
  assert.equal(await js('document.getElementById("settingsPane").textContent.includes("快捷键")'),false);
  assert.equal(await js('Object.keys(window.busy).some(key=>/hotkey/i.test(key))'),false);
  record('settings and preload expose no global shortcut controls or actions');
  await js('document.getElementById("settingsOpacity").value="0";document.getElementById("settingsOpacity").dispatchEvent(new Event("input"))');await sleep(100);
  const after=await js('getComputedStyle(document.documentElement).getPropertyValue("--surface-alpha")');
  assert.equal(Number(after),0);assert.equal(win.getOpacity(),1);
  assert.equal(await js('getComputedStyle(document.documentElement).getPropertyValue("--content-alpha")'),'0');
  assert.equal(JSON.parse(fs.readFileSync(path.join(profile,'settings.json'),'utf8')).opacity??1,stored);
  record('zero background opacity clears every main tint layer without fading text or writing settings');
  await js('window.busy.settingsClose()');await sleep(450);
  assert.equal(await js('getComputedStyle(document.documentElement).getPropertyValue("--surface-alpha")'),before);
  record('closing settings restores the saved background opacity');
  await js('(async()=>{const c=await window.busy.settingsGet();return window.busy.settingsSave({...c.settings,opacity:0});})()');await sleep(100);
  assert.equal(win.getOpacity(),1);assert.equal(JSON.parse(fs.readFileSync(path.join(profile,'settings.json'),'utf8')).opacity,0);
  record('saving zero persists it while keeping native window opacity at one');
  for (const mode of ['settings', 'about']) {
    win.webContents.send('magpie:settings-panel', {open:true,mode});await sleep(100);
    const panel=await js(`(()=>{const p=document.getElementById('settingsPane'),s=getComputedStyle(p);return {background:s.backgroundColor,content:getComputedStyle(document.querySelector('.content')).visibility,opacity:s.opacity};})()`);
    const alpha=Number(panel.background.match(/[\d.]+/g).at(-1));
    assert.ok(alpha>=0.8&&alpha<1,JSON.stringify(panel));
    assert.equal(panel.content,'hidden');
    fs.writeFileSync(path.join(output,mode+'.png'),(await win.webContents.capturePage()).toPNG());
  }
  record('settings and about stay readable even when the main background is fully transparent');
  const refreshed=materialRefreshes;win.emit('blur');await sleep(80);
  assert.ok(materialRefreshes>refreshed);
  record('losing focus refreshes the native background without focusing the widget');
  fs.writeFileSync(path.join(output,'surface.png'),(await win.webContents.capturePage()).toPNG());
  assert.equal(errors.length,0,errors.join('\n'));
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({ok:true,checks,rendererErrors:errors},null,2));server.close();win.destroy();app.exit(0);
 }catch(error){fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({ok:false,checks,error:error.stack,rendererErrors:errors},null,2));server.close();win.destroy();app.exit(1);}
}
server.listen(0,'127.0.0.1',async()=>{
 const gateway=`http://127.0.0.1:${server.address().port}`;
 fs.writeFileSync(path.join(profile,'settings.json'),JSON.stringify({gateway,topmost:false,autostart:false,keepAlive:false,updateMode:'never',usagePeriod:'30d',left:40,top:40}));
 await app.whenReady();
 screen.getCursorScreenPoint=()=>cursor;
 const filename = path.join(root,'src/main.js');
 const mainModule = new Module(filename,module);
 mainModule.filename=filename;
 mainModule.paths=Module._nodeModulePaths(path.dirname(filename));
 mainModule.require=function(id){
  if(id==='./windows-blur.cjs') return {attachBlur:()=>({refresh(){materialRefreshes++;}})};
  if(id==='electron') return {...require('electron'),BrowserWindow:class extends BrowserWindow {
   constructor(options){const {backgroundMaterial,...offscreenOptions}=options;super({...offscreenOptions,transparent:true,roundedCorners:false,hasShadow:false,webPreferences:{...options.webPreferences,offscreen:true}});}
  }};
  return Module.prototype.require.call(this,id);
 };
 mainModule._compile(fs.readFileSync(filename,'utf8'),filename);
});
setTimeout(()=>{fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({ok:false,checks,error:'UI check timed out',rendererErrors:errors,url:win?.webContents.getURL()},null,2));win?.destroy();app.exit(2);},30000).unref();
