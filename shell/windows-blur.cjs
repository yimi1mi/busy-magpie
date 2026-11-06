'use strict';

// koffi and user32 are resolved on first use rather than at require time. The
// region shaper is pure, so its tests can run without a native window; only the
// blur surface itself needs Windows.

let nativeApi = null;

function native() {
  if (nativeApi) return nativeApi;
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  const AccentPolicy = koffi.struct({ state: 'uint32', flags: 'uint32', color: 'uint32', animation: 'uint32' });
  const CompositionData = koffi.struct({ attribute: 'uint32', data: koffi.pointer(AccentPolicy), size: 'size_t' });
  nativeApi = {
    accentSize: koffi.sizeof(AccentPolicy),
    setComposition: user32.func('__stdcall', 'SetWindowCompositionAttribute', 'int', ['void *', koffi.pointer(CompositionData)]),
    getDpi: user32.func('uint32 __stdcall GetDpiForWindow(void *hwnd)'),
  };
  return nativeApi;
}

const ROUND_RADIUS = 22;
const SKIP_LOG_MS = 60_000;

// Builds the window region for a card of `width` x `height`, or null when the
// size is unusable. Returning null is the whole point: setShape installs the
// region Windows uses for hit-testing as well as painting, so a mask derived
// from a zero size would make the entire card click-through while its renderer
// kept drawing normally.
function shapeRegion(width, height) {
  if (!(width > 0) || !(height > 0)) return null;
  const radius = Math.max(1, Math.min(ROUND_RADIUS, Math.floor(width / 2), Math.floor(height / 2)));
  // Too small for a rounded mask: one solid rectangle keeps the whole card
  // clickable. Deriving corners here would yield negative or zero-size bands,
  // and a region made of those is a region with no hit test at all.
  if (width < 2 * radius || height < 2 * radius) {
    return [{ x: 0, y: 0, width, height }];
  }
  const rects = [];
  const insetAt = (y) => Math.floor(radius - Math.sqrt(radius * radius - (radius - y - 0.5) ** 2));
  for (let y = 0; y < radius; y++) {
    const inset = insetAt(y);
    rects.push({ x: inset, y, width: width - inset * 2, height: 1 });
  }
  rects.push({ x: 0, y: radius, width, height: height - radius * 2 });
  for (let y = height - radius; y < height; y++) {
    const inset = insetAt(height - y - 1);
    rects.push({ x: inset, y, width: width - inset * 2, height: 1 });
  }
  // Last line of defence: a zero-area band contributes nothing to the shape,
  // and a mask made only of them would blank the window's hit testing.
  const shaped = rects.filter((rect) => rect.width > 0 && rect.height > 0);
  return shaped.length ? shaped : [{ x: 0, y: 0, width, height }];
}

// Keeps the installed region in step with the window size. `force` rebuilds
// even when nothing changed, which is how a compositor or display reset gets
// repaired; event objects are never `true`, so the ordinary move/resize path
// keeps its cheap early return.
function createRegionShaper({ getSize, getDpi, setShape, logger = () => {}, now = () => Date.now() }) {
  let regionSize = '';
  let lastSkipLog = 0;

  function clip(force = false) {
    const [width, height] = getSize();
    const shape = shapeRegion(width, height);
    if (!shape) {
      // Drop the cache key so the next usable size always rebuilds, and keep
      // the last good region installed rather than blanking the hit test.
      regionSize = '';
      // One line per minute at most: this fires on every move/resize event
      // while the window stays hidden.
      const at = now();
      if (at - lastSkipLog >= SKIP_LOG_MS) {
        lastSkipLog = at;
        try {
          logger(`blur region: skipped (${width}x${height}), keeping the last good shape`);
        } catch {
          // Logging is a courtesy; it must never take the surface down.
        }
      }
      return;
    }
    const key = `${width}/${height}/${getDpi()}`;
    if (force !== true && key === regionSize) return;
    setShape(shape);
    regionSize = key;
  }

  return { clip };
}

function attachBlur(win, logger = () => {}) {
  const handle = win.getNativeWindowHandle();
  const hwnd = handle.length === 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE());
  const api = native();
  const shaper = createRegionShaper({
    getSize: () => win.getSize(),
    getDpi: () => api.getDpi(hwnd),
    setShape: (rects) => win.setShape(rects),
    logger,
  });

  function refresh() {
    if (win.isDestroyed()) return;
    // Blur samples the windows behind us. Tint is drawn by CSS, independently
    // of the text; unlike SystemBackdrop Acrylic this does not add a solid tint.
    const ok = api.setComposition(hwnd, { attribute: 19,
      data: { state: 3, flags: 0, color: 0, animation: 0 }, size: api.accentSize });
    if (!ok) throw new Error('Windows rejected the background blur');
    // refresh() is only called on events that can invalidate the region —
    // show, focus, resume, unlock, a display change — so it rebuilds it.
    shaper.clip(true);
  }

  refresh();
  win.on('resize', shaper.clip);
  win.on('move', shaper.clip);
  return { refresh };
}

module.exports = { attachBlur, shapeRegion, createRegionShaper };
