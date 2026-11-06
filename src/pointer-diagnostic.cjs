'use strict';

// Read-only view of what Windows thinks about this window's pointer routing.
// A card that stopped answering can be caused by the window losing
// WS_EX_TRANSPARENT, by a stale window region, or by another window owning the
// point. Those are exactly the three things reported here, and nothing is
// changed: this is a diagnostic, not a repair.

const GWL_EXSTYLE = -20;
const WS_EX_TRANSPARENT = 0x00000020;
const WS_EX_LAYERED = 0x00080000;
const WS_EX_TOOLWINDOW = 0x00000080;
const WS_EX_NOACTIVATE = 0x08000000;
const GA_ROOT = 2;

let api = null;

function nativeApi() {
  if (api) return api;
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  api = {
    getWindowLong: user32.func('int32 __stdcall GetWindowLongW(uintptr_t,int32)'),
    windowFromPoint: user32.func('uintptr_t __stdcall WindowFromPoint(int32,int32)'),
    getAncestor: user32.func('uintptr_t __stdcall GetAncestor(uintptr_t,uint32)'),
    isWindowVisible: user32.func('int __stdcall IsWindowVisible(uintptr_t)'),
  };
  return api;
}

function hwndOf(win) {
  const handle = win.getNativeWindowHandle();
  return handle.length === 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE());
}

// `point` is optional: without it the hit test uses the window's own centre,
// which is where a stalled card is most likely to be clicked.
function windowsPointerState(win, point) {
  if (process.platform !== 'win32') return { supported: false };
  const native = nativeApi();
  const hwnd = hwndOf(win);
  const exStyle = native.getWindowLong(hwnd, GWL_EXSTYLE) >>> 0;
  const bounds = win.getBounds();
  const x = point && Number.isFinite(point.x) ? Math.round(point.x) : bounds.x + Math.round(bounds.width / 2);
  const y = point && Number.isFinite(point.y) ? Math.round(point.y) : bounds.y + Math.round(bounds.height / 2);
  const atPoint = native.windowFromPoint(x, y);
  const root = atPoint ? native.getAncestor(atPoint, GA_ROOT) : 0;
  return {
    supported: true,
    hwnd: hwnd.toString(),
    point: { x, y },
    exStyle: `0x${exStyle.toString(16)}`,
    clickThrough: Boolean(exStyle & WS_EX_TRANSPARENT),
    layered: Boolean(exStyle & WS_EX_LAYERED),
    toolWindow: Boolean(exStyle & WS_EX_TOOLWINDOW),
    noActivate: Boolean(exStyle & WS_EX_NOACTIVATE),
    hitTestWindow: root ? root.toString() : '0',
    hitTestOwnsPoint: root === hwnd,
    visible: Boolean(native.isWindowVisible(hwnd)),
  };
}

module.exports = { windowsPointerState };
