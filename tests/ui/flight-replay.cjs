const { app, BrowserWindow, ipcMain, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const Module = require('node:module');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'artifacts', 'flight-replay');
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
  await js(`window.flightEvents=[];new MutationObserver(list=>{for(const m of list){if(m.type==='attributes'&&m.attributeName==='data-phase'){const n=m.target;window.flightEvents.push({id:n.dataset.requestId,phase:n.dataset.phase,attempt:n.dataset.attempt});}}}).observe(document.getElementById('birdSky'),{subtree:true,attributes:true,attributeFilter:['data-phase']})`);
  let seq=10,pid=12345;
  const sendRoutes=async routes=>{send('magpie:trace',{pid,seq:++seq,totals:{requests:routes.length},routes});await sleep(60);};
  const route=(id,session='same')=>({id,session,agent:'codex',time:new Date(1761090000000+id*1000).toISOString(),model:'sample-model',provider:'openai',done:false,order:[{id:'a',kind:'account',who:'sample@example.com'},{id:'b',kind:'account',who:'other@example.com'}],tries:[{id:'a',done:false}]});
  const phase=async(id)=>js(`document.querySelector('.flying-bird[data-request-id="${id}"]')?.dataset.phase`);
  const waitPhase=async(id,wanted,limit=4500)=>{const until=Date.now()+limit;while(Date.now()<until){if(await phase(id)===wanted)return;await sleep(50);}throw Error(`request ${id}: expected ${wanted}, got ${await phase(id)}`);};
  await sendRoutes([]);
  const a=route(1);await sendRoutes([a]);await waitPhase(1,'waiting-account');
  await sleep(8500);
  assert.equal(await phase(1),'waiting-account');
  const first=await js('window.flightEvents.filter(e=>e.id==="1"&&e.phase==="agent-account")');assert.equal(first.length,1);
  record('a long unfinished request waits past eight seconds without a second departure');
  a.tries[0]={id:'a',done:true,status:429,rest:{seconds:60}};a.tries.push({id:'b',done:false});await sendRoutes([a]);
  await waitPhase(1,'waiting-account');await sleep(1700);assert.equal(await phase(1),'waiting-account');
  a.done=true;a.status=200;a.tries[1]={id:'b',done:true,status:200};await sendRoutes([a]);await waitPhase(1,'account-agent');await sleep(1600);assert.equal(await phase(1),undefined);
  const moves=await js('window.flightEvents.filter(e=>e.id==="1"&&!e.phase.startsWith("waiting")).map(e=>e.phase)');
  assert.deepEqual(moves,['agent-account','account-hub','hub-account','account-agent']);
  record('retry returns to magpie, flies to the next account, then returns only on completion');
  const quick=route(2);quick.done=true;quick.status=200;quick.tries=[{id:'a',done:true,status:200}];await sendRoutes([a,quick]);await waitPhase(2,'account-agent');await sleep(1600);await sendRoutes([a,quick]);
  assert.equal(await phase(2),undefined);
  record('a new request first observed complete still flies once and is not replayed by duplicate snapshots');
  const many=Array.from({length:6},(_,i)=>route(i+10,'same'));await sendRoutes([a,quick,...many]);await sleep(200);
  assert.equal(await js('document.querySelectorAll(".flying-bird").length'),6);assert.equal(await js('document.getElementById("fanAgents").children.length'),1);
  record('six requests in the same visual group keep six independent flights');
  many.forEach((r,i)=>r.session='session-'+i);await sendRoutes([a,quick,...many]);await sleep(1800);
  assert.equal(await js('document.querySelectorAll(".flying-bird[data-phase=waiting-account]").length'),6);
  assert.equal(await js('document.getElementById("fanAgents").children.length'),4);
  fs.writeFileSync(path.join(output,'groups.png'),(await win.webContents.capturePage()).toPNG());
  record('overflow folds the cards while every request reaches a valid anchor');
  pid++;seq=0;await sendRoutes([route(1)]);await sleep(100);
  assert.equal(await js('document.querySelectorAll(".flying-bird").length'),1);
  send('magpie:connection',{online:false,detail:'test disconnect'});await sleep(100);
  assert.equal(await js('document.querySelectorAll(".flying-bird").length'),0);
  record('gateway restart and disconnect cancel old flights without a false answer');
  assert.equal(errors.length,0,errors.join('\n'));
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({ok:true,checks,rendererErrors:errors},null,2));server.close();app.exit(0);
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
   constructor(options){super({...options,webPreferences:{...options.webPreferences,offscreen:true}});}
  }};
  return Module.prototype.require.call(this,id);
 };
 mainModule._compile(fs.readFileSync(filename,'utf8'),filename);
});
setTimeout(()=>{console.error('UI check timed out');app.exit(2);},45000).unref();
