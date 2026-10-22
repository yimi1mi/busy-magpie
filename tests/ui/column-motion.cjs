const { app, BrowserWindow, ipcMain, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const Module = require('node:module');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'artifacts', 'column-motion');
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
  let seq=40;
  const route=id=>({id,session:'session-'+id,agent:'codex',time:new Date(1761090000000+id*1000).toISOString(),model:'sample-model',provider:'openai',done:false,order:[{id:'a',kind:'account'}],tries:[{id:'a',done:false}]});
  const rows=[101,102,103,104].map(route);
  const sendRoutes=async routes=>{send('magpie:trace',{pid:12345,seq:++seq,totals:{requests:routes.length},routes});await sleep(60);};
  const capture=()=>js(`Object.fromEntries(['fanAgents','fanAccounts'].map(id=>[id,[...document.getElementById(id).children].map(n=>{const r=n.getBoundingClientRect();return {id:n.dataset.id,x:r.x,y:r.y,w:r.width,h:r.height};})]))`);
  const motion=mode=>js(`(()=>{const animations=document.getAnimations().filter(a=>a.effect?.target?.classList?.contains('routing-ghost')||a.effect?.getKeyframes().some(k=>k.translate));for(const a of animations){${mode==='pause'?"a.pause();a.currentTime=Number(a.effect.getTiming().duration)*0.4;":"a.finish();"}}return animations.length;})()`);
  const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.w-b.w,a.h-b.h);
  await sendRoutes(rows.slice(0,2));await sleep(1700);
  for(const [name,next] of [['2 to 4 cards',rows],['4 to 2 cards',[rows[0],rows[3]]]]) {
   const before=await capture();await sendRoutes(next);
   assert((await motion('pause'))>0,name+' must animate');await sleep(30);
   const middle=await capture();
   if(next.length===2) {
    assert.equal(await js('document.querySelectorAll(".routing-ghost").length'),4,'both removed rows should fade out on both sides');
    await sendRoutes(next);await motion('pause');
    assert.equal(await js('document.querySelectorAll(".routing-ghost").length'),4,'a duplicate trace must not cut off exiting cards');
    record('removed cards on both sides keep fading through repeated snapshots');
   }
   fs.writeFileSync(path.join(output,next.length===4?'grow.png':'shrink.png'),(await win.webContents.capturePage()).toPNG());
   await motion('finish');await sleep(70);const after=await capture();
   for(const side of ['fanAgents','fanAccounts']) {
    assert.equal(after[side].length,next.length);
    let interpolated=0;
    for(const final of after[side]) {
     const start=before[side].find(r=>r.id===final.id),mid=middle[side].find(r=>r.id===final.id);
     if(!start||distance(start,final)<0.5)continue;
     assert(distance(mid,start)>0.5,name+' '+side+' left its old geometry');
     assert(distance(mid,final)>0.5,name+' '+side+' has not jumped to final geometry');
     assert(distance(mid,final)<distance(start,final),name+' '+side+' moves toward final geometry');interpolated++;
    }
    assert(interpolated>0,name+' '+side+' must interpolate existing cards');
    record(name+' smoothly resizes and repositions '+(side==='fanAgents'?'left':'right')+' column');
   }
  }
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
