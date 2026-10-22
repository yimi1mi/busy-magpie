const {app, BrowserWindow} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'artifacts/native-blur');
fs.mkdirSync(output, {recursive:true});
app.setPath('userData', path.join(output, 'profile-' + process.pid));

app.whenReady().then(async () => {
  let win;
  try {
    const koffi = require('koffi');
    const material = require('../../src/window-material.cjs').windowMaterial(process.platform, require('node:os').release());
    assert.equal(material.kind, 'blur', 'run this native check on supported Windows');
    win = new BrowserWindow({width:632, height:432, frame:false, backgroundColor:'#00000000', show:false, ...material.options});
    const surface = require('../../shell/windows-blur.cjs').attachBlur(win);
    const hwnd = win.getNativeWindowHandle().readBigUInt64LE();
    const user = koffi.load('user32.dll'), gdi = koffi.load('gdi32.dll');
    const region = gdi.func('void * __stdcall CreateRectRgn(int,int,int,int)')(0,0,0,0);
    const regionType = user.func('int __stdcall GetWindowRgn(void *,void *)')(hwnd,region);
    const dpi = user.func('uint32 __stdcall GetDpiForWindow(void *)')(hwnd) / 96;
    const point = gdi.func('int __stdcall PtInRegion(void *,int,int)');
    assert.equal(regionType,3);
    assert.equal(point(region,Math.round(5*dpi),Math.round(5*dpi)),0);
    assert.notEqual(point(region,Math.round(22*dpi),Math.round(22*dpi)),0);
    gdi.func('int __stdcall DeleteObject(void *)')(region);
    win.setIgnoreMouseEvents(true,{forward:true}); surface.refresh();
    win.setIgnoreMouseEvents(false); surface.refresh();
    assert.equal(win.getOpacity(),1);
    assert.equal(win.isFocused(),false);
    fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({ok:true,kind:material.kind,roundedRegion:true,blurAccepted:true,clickThroughRefresh:true,interactiveRefresh:true,windowOpacity:1,focused:false},null,2));
    win.destroy(); app.exit(0);
  } catch (error) {
    fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({ok:false,error:error.stack},null,2));
    win?.destroy(); app.exit(1);
  }
});
