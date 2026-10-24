const {app,BrowserWindow,ipcMain,screen}=require('electron');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict'),Module=require('node:module');
const root=path.resolve(__dirname,'../..'),output=path.join(root,'artifacts/resize-handles');
const profile=path.join(output,'profile-'+process.pid);
fs.mkdirSync(profile,{recursive:true});
app.setPath('userData',profile);app.setPath('sessionData',profile);
app.getVersion=()=>JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version;
app.disableHardwareAcceleration();
let win,visible=false,ignored=true,cursor={x:-10000,y:-10000},finished=false,lastDirection='';
const checks=[],probes=[],errors=[],sleep=ms=>new Promise(r=>setTimeout(r,ms));
const server=http.createServer((req,res)=>{setTimeout(()=>{if(res.destroyed)return;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url.includes('/usage')?{period:'today',calls:0,input:0,output:0}:{pid:1,seq:1,totals:{requests:0},routes:[]}));},req.url.includes('wait=')?100:0);});
app.on('browser-window-created',(_event,created)=>{
 win=created;win.showInactive=()=>{visible=true;win.emit('show');};win.isVisible=()=>visible;
 win.hide=()=>{visible=false;win.emit('hide');};win.focus=()=>{};win.blur=()=>win.emit('blur');
 const ignore=win.setIgnoreMouseEvents.bind(win);
 win.setIgnoreMouseEvents=(value,options)=>{ignored=value;ignore(value,options);};
 win.webContents.on('console-message',(_event,level,message)=>{if(level>=3)errors.push(message);});
});
ipcMain.on('busy:resize-start',(_event,direction)=>{lastDirection=direction;});
ipcMain.once('busy:ready',()=>setTimeout(run,200));
const js=code=>win.webContents.executeJavaScript(code);
const record=name=>{checks.push(name);console.log('PASS',name);};
function finish(error){
 if(finished)return;finished=true;
 fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({ok:!error,checks,probes,rendererErrors:errors,error:error?.stack,pid:process.pid,url:win?.webContents.getURL()},null,2));
 if(error)console.error(error.stack);
 server.closeAllConnections();server.close();win?.destroy();app.exit(error?1:0);
}
async function points(){return js(`([...document.querySelectorAll('.resize-handle')].map(e=>{const r=e.getBoundingClientRect(),x=Math.floor(r.x+r.width/2),y=Math.floor(r.y+r.height/2);return {direction:e.dataset.resize,x,y,width:r.width,height:r.height,hit:document.elementFromPoint(x,y)?.dataset.resize};}))`);}
async function run(){try{
 const k=require('koffi'),user=k.load('user32.dll'),gdi=k.load('gdi32.dll');
 const getRegion=user.func('int __stdcall GetWindowRgn(void *,void *)');
 const createRegion=gdi.func('void * __stdcall CreateRectRgn(int,int,int,int)');
 const inside=gdi.func('int __stdcall PtInRegion(void *,int,int)');
 const deleteRegion=gdi.func('int __stdcall DeleteObject(void *)');
 const hwnd=win.getNativeWindowHandle().readBigUInt64LE();
 const dpi=user.func('uint32 __stdcall GetDpiForWindow(void *)')(hwnd)/96;
 const region=createRegion(0,0,0,0);assert.equal(getRegion(hwnd,region),3);
 const handles=await points();
 for(const point of handles){
  const b=win.getBounds();cursor={x:b.x+point.x,y:b.y+point.y};await sleep(100);
  probes.push({...point,insideWindow:Boolean(inside(region,Math.round(point.x*dpi),Math.round(point.y*dpi))),ignored,
   resizeCursor:await js('document.body.classList.contains("can-resize")')});
 }
 deleteRegion(region);
 assert.equal(probes.length,8);
 assert.ok(probes.every(p=>p.hit===p.direction&&p.insideWindow&&!p.ignored&&p.resizeCursor),JSON.stringify(probes));
 record('all eight visible resize handles admit pointer input inside the rounded native region');
 for(const material of ['blur','none']){
  const bootstrap=await js('window.busy.bootstrap()');
  win.webContents.send('magpie:settings',{...bootstrap.settings,backgroundMaterial:material});
  for(const width of [632,900]){
   const baseline={x:120,y:120,width,height:Math.round((width-32)/1.5+32)};
   for(const direction of ['n','s','w','e','nw','ne','sw','se']){
    cursor={x:-10000,y:-10000};win.setBounds(baseline);await sleep(100);
    const point=(await points()).find(p=>p.direction===direction);
    cursor={x:baseline.x+point.x,y:baseline.y+point.y};await sleep(100);
    assert.equal(ignored,false,`${material} ${width} ${direction}: pointer stays click-through`);
    lastDirection='';
    await js(`document.elementFromPoint(${point.x},${point.y}).dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,buttons:1,pointerId:1,clientX:${point.x},clientY:${point.y}}))`);
    await sleep(45);assert.equal(lastDirection,direction,`${direction}: renderer did not start resizing`);
    cursor={x:cursor.x+(direction.includes('w')?-36:direction.includes('e')?36:0),y:cursor.y+(direction.includes('n')?-24:direction.includes('s')?24:0)};
    await sleep(65);const after=win.getBounds();
    assert.ok(after.width>baseline.width&&after.height>baseline.height,`${material} ${width} ${direction}: ${JSON.stringify(after)}`);
    if(direction.includes('w'))assert.equal(after.x+after.width,baseline.x+baseline.width);
    if(direction.includes('n'))assert.equal(after.y+after.height,baseline.y+baseline.height);
    await js(`window.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,button:0,buttons:0,pointerId:1}))`);
    await sleep(40);const released=win.getBounds();cursor={x:cursor.x+20,y:cursor.y+20};await sleep(45);
    assert.deepEqual(win.getBounds(),released,`${direction}: resizing must stop on release`);
   }
   record(`${material} ${width}px: four edges and four corners resize and stop on release`);
  }
 }
 cursor={x:-10000,y:-10000};await sleep(100);assert.equal(ignored,false);record('leaving the handles keeps panel clicks blocked');
 assert.equal(errors.length,0,errors.join('\n'));finish();
}catch(error){finish(error);}}
server.listen(0,'127.0.0.1',async()=>{
 fs.writeFileSync(path.join(profile,'settings.json'),JSON.stringify({gateway:`http://127.0.0.1:${server.address().port}`,topmost:false,autostart:false,keepAlive:false,updateMode:'never',quietMotion:true,left:120,top:120}));
 await app.whenReady();screen.getCursorScreenPoint=()=>cursor;
 const filename=path.join(root,'src/main.js'),main=new Module(filename,module);main.filename=filename;main.paths=Module._nodeModulePaths(path.dirname(filename));
 main.require=function(id){
  if(id==='electron')return {...require('electron'),BrowserWindow:class extends BrowserWindow{constructor(options){super({...options,show:false,webPreferences:{...options.webPreferences,offscreen:true}});}}};
  return Module.prototype.require.call(this,id);
 };
 main._compile(fs.readFileSync(filename,'utf8'),filename);
});
setTimeout(()=>finish(new Error('resize regression timed out')),30000).unref();
