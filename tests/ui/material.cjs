const { app, BrowserWindow, ipcMain, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const Module = require('node:module');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'artifacts', 'material');
const profile = path.join(output, 'profile');
fs.mkdirSync(profile, { recursive: true });
fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({running:true}));
app.setPath('userData', profile);
app.setPath('sessionData', profile);
app.getVersion = () => JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
app.disableHardwareAcceleration();
let win, visible = false, ignored = true, cursor = { x: -10000, y: -10000 };
let hitAreas, dragStarted = 0, dragCalls = 0, usageSwitches = 0;
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
  const material=await js('window.busy.bootstrap().then(x=>x.settings.backgroundMaterial)');
  assert.equal(material,'acrylic');
  assert.equal(await js('document.body.classList.contains("native-material")'),true);
  const bounds=await js('(()=>{const r=document.getElementById("stageArea").getBoundingClientRect();return {w:r.width,h:r.height,x:r.x,y:r.y};})()');
  assert.deepEqual(bounds,{w:600,h:400,x:16,y:16});
  record('native background preserves the content canvas and hit coordinates');
  const stored=JSON.parse(fs.readFileSync(path.join(profile,'settings.json'),'utf8')).opacity||1;
  const before=await js('getComputedStyle(document.documentElement).getPropertyValue("--surface-alpha")');
  await openMenu();await menuAction('settings');
  await js('document.getElementById("settingsOpacity").value="40";document.getElementById("settingsOpacity").dispatchEvent(new Event("input"))');await sleep(100);
  const after=await js('getComputedStyle(document.documentElement).getPropertyValue("--surface-alpha")');
  assert.ok(Number(after)<Number(before));assert.equal(win.getOpacity(),1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(profile,'settings.json'),'utf8')).opacity||1,stored);
  record('density preview changes only the background and never fades text or writes settings');
  await js('window.busy.settingsClose()');await sleep(450);
  assert.equal(await js('getComputedStyle(document.documentElement).getPropertyValue("--surface-alpha")'),before);
  record('closing settings restores the saved background density');
  await js('(async()=>{const c=await window.busy.settingsGet();return window.busy.settingsSave({...c.settings,opacity:0.6});})()');await sleep(100);
  assert.equal(win.getOpacity(),1);assert.equal(JSON.parse(fs.readFileSync(path.join(profile,'settings.json'),'utf8')).opacity,0.6);
  record('saving density persists it while keeping native window opacity at one');
  fs.writeFileSync(path.join(output,'surface.png'),(await win.webContents.capturePage()).toPNG());
  assert.equal(errors.length,0,errors.join('\n'));
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({ok:true,checks,rendererErrors:errors},null,2));server.close();win.destroy();app.exit(0);
 }catch(error){fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({ok:false,checks,error:error.stack,rendererErrors:errors},null,2));server.close();win.destroy();app.exit(1);}
}
server.listen(0,'127.0.0.1',async()=>{
 const gateway=`http://127.0.0.1:${server.address().port}`;
 fs.writeFileSync(path.join(profile,'settings.json'),JSON.stringify({gateway,topmost:false,hotkeyOn:false,autostart:false,keepAlive:false,updateMode:'never',guideVersion:1,usagePeriod:'30d',left:40,top:40}));
 await app.whenReady();
 screen.getCursorScreenPoint=()=>cursor;
 const filename = path.join(root,'src/main.js');
 const mainModule = new Module(filename,module);
 mainModule.filename=filename;
 mainModule.paths=Module._nodeModulePaths(path.dirname(filename));
 mainModule.require=function(id){
  if(id==='electron') return {...require('electron'),BrowserWindow:class extends BrowserWindow {
   constructor(options){const {backgroundMaterial,...offscreenOptions}=options;super({...offscreenOptions,transparent:true,roundedCorners:false,hasShadow:false,webPreferences:{...options.webPreferences,offscreen:true}});}
  }};
  return Module.prototype.require.call(this,id);
 };
 mainModule._compile(fs.readFileSync(filename,'utf8'),filename);
});
setTimeout(()=>{console.error('UI check timed out');app.exit(2);},30000).unref();
