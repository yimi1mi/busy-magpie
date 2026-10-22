'use strict';

const koffi = require('koffi');
const user32 = koffi.load('user32.dll');
const AccentPolicy = koffi.struct({ state: 'uint32', flags: 'uint32', color: 'uint32', animation: 'uint32' });
const CompositionData = koffi.struct({ attribute: 'uint32', data: koffi.pointer(AccentPolicy), size: 'size_t' });
const setComposition = user32.func('__stdcall', 'SetWindowCompositionAttribute', 'int', ['void *', koffi.pointer(CompositionData)]);
const getDpi = user32.func('uint32 __stdcall GetDpiForWindow(void *hwnd)');

function attachBlur(win) {
  const handle = win.getNativeWindowHandle();
  const hwnd = handle.length === 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE());
  let regionSize = '';

  function clip() {
    const [width, height] = win.getSize();
    const key = `${width}/${height}/${getDpi(hwnd)}`;
    if (key === regionSize) return;
    const radius = Math.min(22, Math.floor(width / 2), Math.floor(height / 2));
    const rects = [];
    const insetAt = y => Math.floor(radius - Math.sqrt(radius * radius - (radius - y - 0.5) ** 2));
    for (let y = 0; y < radius; y++) {
      const inset = insetAt(y);
      rects.push({ x: inset, y, width: width - inset * 2, height: 1 });
    }
    rects.push({ x: 0, y: radius, width, height: height - radius * 2 });
    for (let y = height - radius; y < height; y++) {
      const inset = insetAt(height - y - 1);
      rects.push({ x: inset, y, width: width - inset * 2, height: 1 });
    }
    // Give Chromium the DIP mask so its resize/DPI handling retains the shape.
    win.setShape(rects);
    regionSize = key;
  }

  function refresh() {
    if (win.isDestroyed()) return;
    // Blur samples the windows behind us. Tint is drawn by CSS, independently
    // of the text; unlike SystemBackdrop Acrylic this does not add a solid tint.
    const ok = setComposition(hwnd, { attribute: 19,
      data: { state: 3, flags: 0, color: 0, animation: 0 }, size: koffi.sizeof(AccentPolicy) });
    if (!ok) throw new Error('Windows rejected the background blur');
    clip();
  }

  refresh();
  win.on('resize', clip);
  win.on('move', clip);
  return { refresh };
}

module.exports = { attachBlur };
