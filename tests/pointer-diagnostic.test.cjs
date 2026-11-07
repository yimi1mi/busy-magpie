const { test } = require('node:test');
const assert = require('node:assert/strict');
const { hitTestVerdict, sameWindow, defaultHitPoint, needsPointerRepair } = require('../src/pointer-diagnostic.cjs');

// The field snapshot had hitTestWindow == hwnd == "1642644" but reported
// hitTestOwnsPoint:false. Electron's handle is a BigInt while koffi returns
// uintptr_t as a Number, so a strict === could never be true.
test('a Number hit-test root matches the BigInt window handle', () => {
  assert.equal(hitTestVerdict(1642644, 1642644n), true, 'the exact field case must be true');
  assert.equal(sameWindow(1642644, 1642644n), true);
  assert.equal(sameWindow('1642644', 1642644n), true, 'string handles must match too');
  assert.equal(sameWindow(1642644n, 1642644n), true);
});

test('a hit test owned by another window or nobody is not ours', () => {
  assert.equal(hitTestVerdict(0, 1642644n), false, 'no window at the point');
  assert.equal(hitTestVerdict(6689082, 1642644n), false, 'a real other window');
  assert.equal(sameWindow(null, 1642644n), false);
  assert.equal(sameWindow(undefined, 1642644n), false);
});

test('only a real native fault triggers an input repair', () => {
  // GetWindowRgn returning 0 means the window has no custom region: a plain,
  // fully clickable rectangle. Treating that as an error made the 30 s probe
  // rebuild the input state forever.
  assert.equal(needsPointerRepair({ supported: true, clickThrough: false, regionKind: 'NO_REGION' }), false);
  assert.equal(needsPointerRepair({ supported: true, clickThrough: false, regionKind: 'SIMPLEREGION' }), false);
  assert.equal(needsPointerRepair({ supported: true, clickThrough: false, regionKind: 'COMPLEXREGION' }), false);
  assert.equal(needsPointerRepair({ supported: true, clickThrough: false, regionKind: 'UNKNOWN' }), false);
  assert.equal(needsPointerRepair({ supported: false }), false);
  assert.equal(needsPointerRepair(null), false);
  assert.equal(needsPointerRepair({ supported: true, clickThrough: true, regionKind: 'NO_REGION' }), true);
  assert.equal(needsPointerRepair({ supported: true, clickThrough: false, regionKind: 'NULLREGION' }), true);
});

test('the probe point is the rightmost control, not the window centre', () => {
  const bounds = { x: 1288, y: 0, width: 632, height: 432 };
  const areas = {
    controls: [
      { x: 300, y: 35, width: 90, height: 27 },
      { x: 568, y: 35, width: 28, height: 28 }, // the dots
    ],
  };
  assert.deepEqual(defaultHitPoint(bounds, areas), { x: 1288 + 582, y: 49 });
  // No hit areas yet (renderer not ready): fall back near the top-right corner.
  assert.deepEqual(defaultHitPoint(bounds, null), { x: 1288 + 598, y: 49 });
  assert.deepEqual(defaultHitPoint(bounds, { controls: [] }), { x: 1288 + 598, y: 49 });
});
