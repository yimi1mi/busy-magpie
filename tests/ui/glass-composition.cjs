const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),k=require('koffi');
const root=path.resolve(__dirname,'../..'),output=path.join(root,'artifacts/glass-composition');
fs.mkdirSync(output,{recursive:true});app.setPath('userData',path.join(output,'profile-'+process.pid));
const user=k.load('user32.dll'),gdi=k.load('gdi32.dll'),dwm=k.load('dwmapi.dll');
const Rect=k.struct({left:'int32',top:'int32',right:'int32',bottom:'int32'});
const getRect=user.func('__stdcall','GetWindowRect','int',['void *',k.out(k.pointer(Rect))]);
const getDC=user.func('void * __stdcall GetDC(void *)'),releaseDC=user.func('int __stdcall ReleaseDC(void *,void *)');
const getPixel=gdi.func('uint32 __stdcall GetPixel(void *,int,int)'),flush=dwm.func('int __stdcall DwmFlush()');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let back,front,hwnd;const checks=[],samples=[];
const color=c=>[c&255,(c>>>8)&255,(c>>>16)&255];
const distance=(a,b)=>a.reduce((n,v,i)=>n+Math.abs(v-b[i]),0);
function pixels(){const rect={},rear={};getRect(hwnd,rect);getRect(back.getNativeWindowHandle().readBigUInt64LE(),rear);const [width,height]=front.getSize(),scale=(rect.right-rect.left)/width,dc=getDC(null);const at=(x,y)=>color(getPixel(dc,rect.left+Math.round(x*scale),rect.top+Math.round(y*scale)));const result={reference:color(getPixel(dc,rear.left+15,rear.top+15)),corners:[[1,1],[width-2,1],[1,height-2],[width-2,height-2]].map(([x,y])=>at(x,y)),center:at(300,235),marker:at(55,55)};releaseDC(null,dc);return result;}
async function paint(colorName){await back.webContents.executeJavaScript(`document.body.style.background=${JSON.stringify(colorName==='red'?'rgb(220,40,30)':'rgb(30,90,230)')}`);for(let n=0;n<30;n++){await sleep(60);flush();const p=pixels(),c=p.reference,m=p.marker;const backgroundReady=colorName==='red'?c[0]>c[1]+60&&c[0]>c[2]+60:c[2]>c[0]+60&&c[2]>c[1]+60;const frontReady=m[1]>m[0]+60&&m[1]>m[2]+40;if(backgroundReady&&frontReady){await sleep(100);flush();return pixels();}}throw Error('controlled test windows did not paint');}
async function measure(name,transparent){const red=await paint('red'),blue=await paint('blue');samples.push({name,red,blue});for(const shot of [red,blue])for(const corner of shot.corners)assert.ok(distance(corner,shot.reference)<100,`${name}: black corner ${corner} over ${shot.reference}`);const spread=distance(red.center,blue.center);if(transparent)assert.ok(spread>180,`${name}: background disappeared (spread ${spread})`);else assert.ok(spread<15,`${name}: opaque background still changes (spread ${spread})`);assert.ok(distance(red.marker,blue.marker)<12,`${name}: foreground faded with background`);checks.push(name);}
app.whenReady().then(async()=>{try{
 back=new BrowserWindow({x:30,y:30,width:1000,height:700,frame:false,show:false,focusable:false,skipTaskbar:true,alwaysOnTop:true});await back.loadURL('data:text/html,<body style="margin:0;background:rgb(220,40,30)"></body>');
 front=new BrowserWindow({x:74,y:74,width:632,height:432,frame:false,transparent:true,backgroundColor:'#00000000',show:false,focusable:false,skipTaskbar:true,alwaysOnTop:true,roundedCorners:false,hasShadow:false});
 const html=`<!doctype html><html><head><link rel="stylesheet" href="file:///${root.replaceAll('\\','/')}/web/styles.css"></head><body class="native-material"><div id="app"><div class="card"><div class="stage-area"><div class="stage-canvas"><div class="content"></div></div></div></div></div><div style="position:absolute;left:50px;top:50px;width:12px;height:12px;background:rgb(20,240,110);z-index:9999"></div></body></html>`;
 fs.writeFileSync(path.join(output,'fixture.html'),html);await front.loadFile(path.join(output,'fixture.html'));await front.webContents.executeJavaScript('for(const [k,v] of Object.entries({"--ui":"1","--surface-alpha":"0","--content-alpha":"0"}))document.documentElement.style.setProperty(k,v)');
 hwnd=front.getNativeWindowHandle().readBigUInt64LE();require('../../shell/windows-blur.cjs').attachBlur(front);back.showInactive();front.showInactive();front.moveTop();
 await measure('zero opacity reveals red and blue backgrounds with clean corners',true);
 front.setIgnoreMouseEvents(true,{forward:true});await measure('click-through preserves transparency and corners',true);
 front.setIgnoreMouseEvents(false);await measure('interactive mode preserves transparency and corners',true);
 await front.webContents.executeJavaScript('document.documentElement.style.setProperty("--surface-alpha","1");document.documentElement.style.setProperty("--content-alpha","0.24")');await measure('full background opacity hides the rear window but keeps foreground clear',false);
 await front.webContents.executeJavaScript('document.documentElement.style.setProperty("--surface-alpha","0");document.documentElement.style.setProperty("--content-alpha","0")');front.setSize(700,460);await sleep(100);await measure('resizing retains the rounded transparent window',true);
 fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({ok:true,checks,samples},null,2));front.destroy();back.destroy();app.exit(0);
}catch(error){fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({ok:false,error:error.stack,checks,samples},null,2));front?.destroy();back?.destroy();app.exit(1);}});
setTimeout(()=>{fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({ok:false,error:'composition test timed out',checks,samples}));front?.destroy();back?.destroy();app.exit(2);},25000).unref();
