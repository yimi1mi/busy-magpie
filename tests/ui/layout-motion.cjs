const { app, BrowserWindow, ipcMain, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const Module = require('node:module');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'artifacts', 'layout-motion');
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
  const send=win.webContents.send.bind(win.webContents);
  win.webContents.send=(channel,...args)=>['magpie:trace','magpie:connection'].includes(channel)?undefined:send(channel,...args);
  let seq=20;
  const route=(id,session)=>({id,session,agent:'codex',time:new Date(1761090000000+id*1000).toISOString(),model:'sample-model',provider:'openai',done:false,order:[{id:'a',kind:'account'}],tries:[{id:'a',done:false}]});
  const a=route(1,'a'),b=route(2,'b'),c=route(3,'c');
  const sendRoutes=async routes=>{send('magpie:trace',{pid:12345,seq:++seq,totals:{requests:routes.length},routes});await sleep(80);};
  const rect=selector=>js(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};})()`);
  const motion=async(mode)=>js(`(()=>{const a=document.getAnimations().filter(a=>a.effect.getKeyframes().some(k=>k.translate));a.forEach(a=>{${mode==='pause'?'a.pause();a.currentTime=160;':'a.finish();'}});return a.length;})()`);
  const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.w-b.w,a.h-b.h);
  await sendRoutes([]);await sendRoutes([a]);await sleep(1650);const before=await rect('#agentNode');
  await sendRoutes([a,b]);assert((await motion('pause'))>0,'single → multi must animate, not cut');await sleep(50);
  const middle=await rect('#fanAgents [data-id="1"]');
  fs.writeFileSync(path.join(output,'single-to-multi.png'),(await win.webContents.capturePage()).toPNG());
  await motion('finish');await sleep(100);const after=await rect('#fanAgents [data-id="1"]');
  assert(distance(middle,before)>0.5);assert(distance(middle,after)>0.5);assert(distance(middle,after)<distance(before,after));
  record('single to multi interpolates card position and size');
  await sendRoutes([a,b,c]);assert((await motion('pause'))>0,'lane count changes must animate');await sleep(50);
  const held=await js(`(()=>{const bird=document.querySelector('.flying-bird[data-request-id="1"]'),account=document.querySelector('#fanAccounts [data-id="1"]'),p=bird.querySelector('.packet').getBoundingClientRect(),r=account.getBoundingClientRect();return {phase:bird.dataset.phase,distance:Math.hypot(p.x+p.width/2-r.x,p.y+p.height/2-(r.y+r.height/2))};})()`);
  assert.equal(held.phase,'waiting-account');assert(held.distance<1,JSON.stringify(held));
  const paths=await js('document.querySelectorAll("#fanWires .fan-wire-path").length');assert.equal(paths,6);
  await motion('finish');await sleep(100);
  record('multi-card count changes animate while wires remain connected');
  await sendRoutes([a]);assert((await motion('pause'))>0,'multi → single must animate');await sleep(50);
  assert.equal(await js('document.body.classList.contains("multi")'),false);
  assert.equal(await js('document.querySelectorAll("#singleWires .fan-wire-path").length'),2);
  await motion('finish');await sleep(100);assert.equal(await js('document.querySelectorAll(".routing-ghost").length'),0);
  record('multi to single animates and removes departing-card ghosts');
  await sendRoutes([a,b]);await sendRoutes([a,b,c]);await sendRoutes([a]);await sleep(700);
  assert.equal(await js('document.querySelectorAll(".routing-ghost").length'),0);
  assert.equal(await js('document.body.classList.contains("multi")'),false);
  record('rapid layout changes settle without stale cards');
  await js('(async()=>{const current=await window.busy.settingsGet();return window.busy.settingsSave({...current.settings,quietMotion:true});})()');await sendRoutes([a,b]);
  assert.equal(await motion('pause'),0);
  assert.equal(await js('document.querySelectorAll(".flying-bird").length'),0);
  record('quiet mode makes layout changes immediate and stops flights');
  assert.equal(errors.length,0,errors.join('\n'));
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({ok:true,checks,rendererErrors:errors,before,middle,after},null,2));server.close();app.exit(0);
 }catch(error){fs.writeFileSync(path.join(output,'failed.png'),(await win.webContents.capturePage()).toPNG());fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({ok:false,checks,error:error.stack,rendererErrors:errors},null,2));server.close();app.exit(1);}
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
   setBackgroundMaterial() {}
   constructor(options){const {backgroundMaterial,...offscreenOptions}=options;super({...offscreenOptions,transparent:true,roundedCorners:false,hasShadow:false,webPreferences:{...options.webPreferences,offscreen:true}});}
  }};
  return Module.prototype.require.call(this,id);
 };
 mainModule._compile(fs.readFileSync(filename,'utf8'),filename);
});
setTimeout(()=>{console.error('UI check timed out');app.exit(2);},30000).unref();
