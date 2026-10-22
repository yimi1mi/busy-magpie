'use strict';

const koffi = require('koffi');
const user32 = koffi.load('user32.dll');
const gdi32 = koffi.load('gdi32.dll');
const AccentPolicy = koffi.struct({ state: 'uint32', flags: 'uint32', color: 'uint32', animation: 'uint32' });
const CompositionData = koffi.struct({ attribute: 'uint32', data: koffi.pointer(AccentPolicy), size: 'size_t' });
const Rect = koffi.struct({ left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
const setComposition = user32.func('__stdcall', 'SetWindowCompositionAttribute', 'int', ['void *', koffi.pointer(CompositionData)]);
const getRect = user32.func('__stdcall', 'GetWindowRect', 'int', ['void *', koffi.out(koffi.pointer(Rect))]);
const getDpi = user32.func('uint32 __stdcall GetDpiForWindow(void *hwnd)');
const createRegion = gdi32.func('void * __stdcall CreateRoundRectRgn(int left, int top, int right, int bottom, int width, int height)');
const setRegion = user32.func('int __stdcall SetWindowRgn(void *hwnd, void *region, int redraw)');
const deleteObject = gdi32.func('int __stdcall DeleteObject(void *object)');

function attachBlur(win) {
  const handle = win.getNativeWindowHandle();
  const hwnd = handle.length === 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE());
  let regionSize = '';

  function clip() {
    const rect = {};
    if (!getRect(hwnd, rect)) return;
    const width = rect.right - rect.left, height = rect.bottom - rect.top;
    const diameter = Math.round(44 * (getDpi(hwnd) || 96) / 96);
    const key = `${width}/${height}/${diameter}`;
    if (key === regionSize) return;
    const region = createRegion(0, 0, width + 1, height + 1, diameter, diameter);
    if (!region) return;
    // SetWindowRgn takes ownership only when the call succeeds.
    if (setRegion(hwnd, region, 1)) regionSize = key;
    else deleteObject(region);
  }

  function refresh() {
    if (win.isDestroyed()) return;
    // Blur samples the windows behind us. Tint is drawn by CSS, independently
    // of the text; unlike SystemBackdrop Acrylic this does not add a solid tint.
    const ok = setComposition(hwnd, { attribute: 19,
      data: { state: 3, flags: 2, color: 0, animation: 0 }, size: koffi.sizeof(AccentPolicy) });
    if (!ok) throw new Error('Windows rejected the background blur');
    clip();
  }

  refresh();
  win.on('resize', clip);
  return { refresh };
}

module.exports = { attachBlur };
