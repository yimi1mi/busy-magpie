const { app, BrowserWindow, ipcMain, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const Module = require('node:module');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'artifacts', 'account-metrics');
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
  await js('(async()=>{const c=await window.busy.settingsGet();return window.busy.settingsSave({...c.settings,quietMotion:true});})()');
  let seq=20;const now=Date.now();
  const row=id=>({id,session:'session-'+id,agent:'codex',time:new Date(now-6000).toISOString(),model:'sample-model',provider:'openai',done:true,status:200,ms:6000,ttft:1000,usage:[{out:500,in:100,cache_read:900}],order:[{id:'a',kind:'account',icon:'openai'}],tries:[{id:'a',done:true,status:200}]});
  const shown=[row(100),row(101)];
  const feed=async()=>{send('magpie:trace',{pid:12345,seq:++seq,now:new Date(now).toISOString(),totals:{requests:shown.length},routes:shown});await sleep(120);};
  await feed();
  const data=await js('([...document.querySelectorAll("#fanAccounts .account-token")].map(e=>({text:e.textContent,display:getComputedStyle(e).display})))');
  assert.equal(data.length,2);for(const d of data){assert.match(d.text,/输出 500.*100 tok\/s/);assert.notEqual(d.display,'none');}
  record('each completed account card shows output tokens and measured stream speed');
  assert.match(await js('document.querySelector("#fanAccounts .node").title'),/缓存 900.*90%/);
  record('the hover detail retains cache and timing data');
  for(const n of [3,4]){shown.push(row(100+n));await feed();
   const boxes=await js('([...document.querySelectorAll("#fanAccounts .account-token")].map(e=>{const r=e.getBoundingClientRect(),p=e.parentElement.getBoundingClientRect();return {visible:getComputedStyle(e).display!=="none",fits:r.bottom<=p.bottom+0.5,width:e.scrollWidth<=e.clientWidth};}))');
   assert.equal(boxes.length,n);assert.ok(boxes.every(x=>x.visible&&x.fits&&x.width),JSON.stringify(boxes));
   fs.writeFileSync(path.join(output,'cards-'+n+'.png'),(await win.webContents.capturePage()).toPNG());
  }
  record('three and four account rows keep token and speed text inside the cards');
  shown[0].reasoningHidden=true;shown[0].usage[0].reasoning=300;await feed();
  assert.doesNotMatch(await js(`document.querySelector('#fanAccounts [data-id="100"] .account-token').textContent`),/tok\/s/);
  record('missing visible-stream timing never produces a fabricated speed');
  shown[1].done=false;shown[1].tries[0].done=false;
  const grouped={...row(200),session:shown[1].session,done:false,tries:[{id:'a',done:false}]};shown.push(grouped);await feed();
  assert.match(await js(`document.querySelector('#fanAccounts [data-id="101"] .account-token').textContent`),/^本条 /);
  record('a folded group labels metrics as belonging to its representative request');
  assert.equal(errors.length,0,errors.join('\n'));
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({ok:true,checks,rendererErrors:errors},null,2));server.close();win.destroy();app.exit(0);
 }catch(error){fs.writeFileSync(path.join(output,'failed.png'),(await win.webContents.capturePage()).toPNG());fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({ok:false,checks,error:error.stack,rendererErrors:errors},null,2));server.close();win.destroy();app.exit(1);}
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
