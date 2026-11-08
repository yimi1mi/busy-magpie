'use strict';

// Read-only view of what Windows thinks about this window's pointer routing.
// A card that stopped answering can be caused by the window losing
// WS_EX_TRANSPARENT, by a stale window region, or by another window owning the
// point. Those are exactly the things reported here, and nothing is changed:
// this is a diagnostic, not a repair.

const GWL_EXSTYLE = -20;
const WS_EX_TRANSPARENT = 0x00000020;
const WS_EX_LAYERED = 0x00080000;
const WS_EX_TOOLWINDOW = 0x00000080;
const WS_EX_NOACTIVATE = 0x08000000;
const GA_ROOT = 2;
// GetWindowRgn: 0 means the window has NO custom region at all (a plain, fully
// clickable rectangle), which is healthy. Only NULLREGION (an empty shape) is
// the fault that blanks the hit test.
const REGION_KIND = { 0: 'NO_REGION', 1: 'NULLREGION', 2: 'SIMPLEREGION', 3: 'COMPLEXREGION' };

// Pure decision used by the assertion loop. A missing/complex region or a
// failure to probe is NOT a reason to rebuild the native input state.
function needsPointerRepair(state) {
  return Boolean(state && state.supported
    && (state.clickThrough || state.regionKind === 'NULLREGION'));
}

// The four declarations below were already in use in the field; keep them in
// their own group so an experimental declaration can never break startup.
let coreApi = null;
let extraApi;

function core() {
  if (coreApi) return coreApi;
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  // WindowFromPoint takes POINT *by value* — 8 bytes in one x64 register.
  // Declaring it as (int32,int32) put x and y in two separate registers, so
  // Windows read y from the wrong place and returned the window at a bogus
  // point (the desktop). That made every probe report hitTestOwnsPoint:false
  // and drove a hide/show self-heal every minute.
  koffi.struct('POINT', { x: 'int32', y: 'int32' });
  coreApi = {
    getWindowLong: user32.func('int32 __stdcall GetWindowLongW(uintptr_t,int32)'),
    windowFromPoint: user32.func('uintptr_t __stdcall WindowFromPoint(POINT)'),
    getAncestor: user32.func('uintptr_t __stdcall GetAncestor(uintptr_t,uint32)'),
    isWindowVisible: user32.func('int __stdcall IsWindowVisible(uintptr_t)'),
  };
  return coreApi;
}

// Optional extras: window title/class and the installed region. If any of
// these declarations is unavailable on a given Windows build, the diagnostic
// degrades to the core fields instead of taking the card down at require time.
function extra() {
  if (extraApi !== undefined) return extraApi;
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const gdi32 = koffi.load('gdi32.dll');
    extraApi = {
      getWindowTextW: user32.func('int __stdcall GetWindowTextW(uintptr_t, _Out_ uint16 *, int32)'),
      getClassNameW: user32.func('int __stdcall GetClassNameW(uintptr_t, _Out_ uint16 *, int32)'),
      getWindowRgn: user32.func('int __stdcall GetWindowRgn(uintptr_t, uintptr_t)'),
      createRectRgn: gdi32.func('uintptr_t __stdcall CreateRectRgn(int32,int32,int32,int32)'),
      getRgnBox: gdi32.func('int __stdcall GetRgnBox(uintptr_t, _Out_ int32 *)'),
      deleteObject: gdi32.func('int __stdcall DeleteObject(uintptr_t)'),
    };
  } catch {
    extraApi = false;
  }
  return extraApi;
}

function hwndOf(win) {
  const handle = win.getNativeWindowHandle();
  return handle.length === 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE());
}

// Electron hands us a BigInt handle while koffi returns uintptr_t values that
// may be Number or BigInt. A strict === between them is always false, which
// made hitTestOwnsPoint report a false negative even when the hit test landed
// on this very window. Compare by value, not by JS type.
function sameWindow(a, b) {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  try {
    return BigInt(a) === BigInt(b);
  } catch {
    return String(a) === String(b);
  }
}

// The exact verdict windowsPointerState reports, split out so the BigInt/
// Number regression can be tested without a native window.
function hitTestVerdict(root, hwnd) {
  return root ? sameWindow(root, hwnd) : false;
}

function readWindowString(fn, hwnd) {
  if (!fn) return '';
  try {
    const buffer = new Uint16Array(256);
    const length = fn(hwnd, buffer, buffer.length);
    if (!(length > 0)) return '';
    return String.fromCharCode(...buffer.subarray(0, Math.min(length, buffer.length - 1)));
  } catch {
    return '';
  }
}

function regionState(hwnd) {
  const api = extra();
  if (!api) return { regionKind: 'UNKNOWN', regionBox: null };
  let probe = 0;
  try {
    probe = api.createRectRgn(0, 0, 1, 1);
    if (!probe) return { regionKind: 'UNKNOWN', regionBox: null };
    const kind = api.getWindowRgn(hwnd, probe);
    if (kind === 1) return { regionKind: 'NULLREGION', regionBox: null };
    // 0 means the window has no custom region at all, so the probe region is
    // still holding its 1x1 initial value. Reporting GetRgnBox for it would
    // claim the card is one pixel wide; a plain rectangle is the healthy case.
    if (kind === 0) return { regionKind: 'NO_REGION', regionBox: null };
    const box = new Int32Array(4);
    const boxKind = api.getRgnBox(probe, box);
    return {
      regionKind: REGION_KIND[kind] ?? String(kind),
      regionBox: boxKind ? { left: box[0], top: box[1], right: box[2], bottom: box[3] } : null,
    };
  } catch {
    return { regionKind: 'UNKNOWN', regionBox: null };
  } finally {
    if (probe) {
      try { api.deleteObject(probe); } catch { /* best effort */ }
    }
  }
}

// Desktop shells are not "another window covering the card": a point that lands
// on them means our own probe fell outside the window, not that something is
// sitting on top of it.
const DESKTOP_CLASSES = new Set(['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd']);

function isDesktopWindow(state) {
  return Boolean(state && state.hitTestClass && DESKTOP_CLASSES.has(state.hitTestClass));
}

// The dots button is the control that stops answering, so probe there rather
// than at the window centre (which can sit over another window entirely).
// `areas` is the renderer's hit-area report; its rightmost control is the dots
// in both the wide layout and the compact strip.
//
// The reported areas can still describe the *previous* layout for a frame
// after a compact/wide switch, so the point is clamped into the window. A
// probe outside our own bounds would land on the desktop and look exactly like
// an occluding window.
function defaultHitPoint(bounds, areas) {
  const controls = areas && Array.isArray(areas.controls) ? areas.controls : [];
  const rightmost = controls.reduce((best, rect) => {
    if (!rect || !Number.isFinite(rect.x) || !Number.isFinite(rect.width)) return best;
    return !best || rect.x + rect.width > best.x + best.width ? rect : best;
  }, null);
  const inside = (x, y) => ({
    x: Math.round(Math.min(bounds.x + bounds.width - 1, Math.max(bounds.x, x))),
    y: Math.round(Math.min(bounds.y + bounds.height - 1, Math.max(bounds.y, y))),
  });
  if (rightmost && rightmost.width > 0 && rightmost.height > 0) {
    return inside(
      bounds.x + rightmost.x + rightmost.width / 2,
      bounds.y + rightmost.y + rightmost.height / 2,
    );
  }
  // Fall back to the top-right corner where the dots live in the wide layout.
  return inside(
    bounds.x + Math.max(0, bounds.width - 34),
    bounds.y + Math.min(bounds.height - 1, 49),
  );
}

function windowsPointerState(win, point, areas) {
  if (process.platform !== 'win32') return { supported: false };
  const native = core();
  const hwnd = hwndOf(win);
  const exStyle = native.getWindowLong(hwnd, GWL_EXSTYLE) >>> 0;
  const bounds = win.getBounds();
  const target = point && Number.isFinite(point.x) && Number.isFinite(point.y)
    ? { x: Math.round(point.x), y: Math.round(point.y) }
    : defaultHitPoint(bounds, areas);
  const atPoint = native.windowFromPoint({ x: target.x, y: target.y });
  const root = atPoint ? native.getAncestor(atPoint, GA_ROOT) : 0;
  const owns = hitTestVerdict(root, hwnd);
  const api = extra();
  return {
    supported: true,
    hwnd: hwnd.toString(),
    point: target,
    exStyle: `0x${exStyle.toString(16)}`,
    clickThrough: Boolean(exStyle & WS_EX_TRANSPARENT),
    layered: Boolean(exStyle & WS_EX_LAYERED),
    toolWindow: Boolean(exStyle & WS_EX_TOOLWINDOW),
    noActivate: Boolean(exStyle & WS_EX_NOACTIVATE),
    hitTestWindow: root ? root.toString() : '0',
    hitTestOwnsPoint: owns,
    // Only worth reading when the point belongs to somebody else.
    hitTestTitle: !owns && root && api ? readWindowString(api.getWindowTextW, root) : '',
    hitTestClass: !owns && root && api ? readWindowString(api.getClassNameW, root) : '',
    ...regionState(hwnd),
    visible: Boolean(native.isWindowVisible(hwnd)),
  };
}

module.exports = { windowsPointerState, sameWindow, hitTestVerdict, defaultHitPoint, needsPointerRepair, isDesktopWindow };
