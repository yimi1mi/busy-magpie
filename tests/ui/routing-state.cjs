const { app, BrowserWindow, ipcMain, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const Module = require('node:module');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'artifacts', 'routing-state');
const profile = path.join(output, 'profile-' + process.pid);
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
  await js('(async()=>{const current=await window.busy.settingsGet();return window.busy.settingsSave({...current.settings,quietMotion:true});})()');
  const start=Date.now()-2000;
  const row=(id,offset)=>({id,session:'session-'+id,agent:'codex',time:new Date(start+offset).toISOString(),model:'sample-model',provider:'openai',done:false,ms:0,order:[{id:'a',kind:'account'}],tries:[{id:'a',done:false,status:0}]});
  const a=row(100,0),b=row(101,1000),shown=[a,b];let seq=50;
  const feed=async(now)=>{send('magpie:trace',{pid:12345,seq:++seq,now:new Date(now).toISOString(),totals:{requests:2},routes:shown});await sleep(80);};
  await feed(Date.now());
  a.done=true;a.ms=2000;a.status=200;a.tries[0]={id:'a',done:true,status:200};
  const ended=start+2000;await feed(ended+100);
  assert.equal(await js('document.body.classList.contains("multi")'),true,'completed card must remain alongside the active card');
  assert.equal(await js('document.querySelectorAll("#fanAgents .node").length'),2);
  record('completed cards remain visible alongside active requests');
  const state=async(id,side)=>js(`document.querySelector('#fanWires [data-route="${id}"][data-side="${side}"]')?.dataset.state`);
  assert.equal(await state(100,'out'),'lit');assert.equal(await state(100,'in'),'idle');
  assert.equal(await state(101,'out'),'live');assert.equal(await state(101,'in'),'live');
  const tones=await js(`(()=>{const incoming=document.querySelector('#fanWires [data-route="100"][data-side="in"] .fan-wire-track'),outgoing=document.querySelector('#fanWires [data-route="100"][data-side="out"] .fan-wire-track'),packet=document.querySelector('#fanWires [data-route="100"][data-side="out"] .fan-wire-path');return {incoming:getComputedStyle(incoming).stroke,outgoing:getComputedStyle(outgoing).stroke,packet:getComputedStyle(packet).display};})()`);
  assert.notEqual(tones.incoming,tones.outgoing);assert.equal(tones.packet,'none');
  record('successful account wires stay lit while completed agent wires stop flowing');
  fs.writeFileSync(path.join(output,'completion.png'),(await win.webContents.capturePage()).toPNG());
  await feed(ended+11750);await sleep(650);
  assert.equal(await js('document.body.classList.contains("multi")'),false,'completed card expires after twelve seconds without another trace');
  record('the twelve-second retention expires without a polling update');
  b.done=true;b.ms=1000;b.status=200;b.tries[0]={id:'a',done:true,status:200};await feed(ended+60000);
  assert.equal(await js('document.getElementById("accountNode").dataset.state'),'done');
  assert.equal(await js('document.querySelector("#singleWires [data-side=out]").dataset.state'),'lit');
  assert.equal(await js('document.querySelectorAll(".flying-bird").length'),0);
  record('the latest completed request remains as a still overview');
  b.status=429;b.tries[0]={id:'a',done:true,status:429,rest:{until:new Date(ended+120000).toISOString()}};await feed(ended+61000);
  assert.equal(await js('document.querySelector("#singleWires [data-side=out]").dataset.state'),'rest');
  assert.notEqual(await js('getComputedStyle(document.querySelector("#singleWires [data-side=out] .fan-wire-track")).strokeDasharray'),'none');
  await feed(ended+121000);
  assert.equal(await js('document.querySelector("#singleWires [data-side=out]").dataset.state'),'idle');
  record('resting account wires dim until the recorded rest expires');
  await js('(async()=>{const current=await window.busy.settingsGet();return window.busy.settingsSave({...current.settings,quietMotion:false});})()');
  shown.push(row(102,3000));await feed(ended+122000);
  const live=await js(`(()=>{const e=document.querySelector('#singleWires [data-side="out"] .fan-wire-path'),s=getComputedStyle(e);return {state:e.parentElement.dataset.state,animation:s.animationName,display:s.display};})()`);
  assert.equal(live.state,'live');assert.equal(live.animation,'wireFlow');assert.notEqual(live.display,'none');
  const dash=await js(`(()=>{const e=document.querySelector('#singleWires [data-side="out"] .fan-wire-path');return {dash:getComputedStyle(e).strokeDasharray,offset:getComputedStyle(e).strokeDashoffset,normalized:e.hasAttribute('pathLength')};})()`);
  await sleep(180);
  assert.equal(dash.dash,'3px, 5px');assert.equal(dash.normalized,false);
  assert.notEqual(await js('getComputedStyle(document.querySelector("#singleWires [data-side=out] .fan-wire-path")).strokeDashoffset'),dash.offset);
  record('active request wires resume their flow when motion is enabled');
  assert.equal(errors.length,0,errors.join('\n'));
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({ok:true,checks,rendererErrors:errors},null,2));server.close();app.exit(0);
 }catch(error){fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({ok:false,checks,error:error.stack,rendererErrors:errors},null,2));server.close();app.exit(1);}
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
  if(id==='./windows-blur.cjs') return {attachBlur:()=>({refresh(){}})};
  if(id==='electron') return {...require('electron'),BrowserWindow:class extends BrowserWindow {
   constructor(options){const {backgroundMaterial,...offscreenOptions}=options;super({...offscreenOptions,transparent:true,roundedCorners:false,hasShadow:false,webPreferences:{...options.webPreferences,offscreen:true}});}
  }};
  return Module.prototype.require.call(this,id);
 };
 mainModule._compile(fs.readFileSync(filename,'utf8'),filename);
});
setTimeout(()=>{console.error('UI check timed out');app.exit(2);},30000).unref();
