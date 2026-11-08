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

// The field diagnostic reported buttonRect 0x0 / elementAt "div#app" while the
// card was in compact mode: the probe was looking for the wide card's dots
// button, which is display:none there. Both layouts must be probed correctly.
test('the probe targets the menu control of the layout on screen', async () => {
  const { pickProbeTargets, menuControlId } = await import('../web/diagnostic-probe.mjs');

  assert.equal(menuControlId(true), 'compactMenu', 'the compact strip uses #compactMenu');
  assert.equal(menuControlId(false), 'quickMenuToggle', 'the wide card uses #quickMenuToggle');

  const compact = pickProbeTargets(true);
  for (const id of ['compactMenu', 'compactExpand', 'compactPill', 'compactDragBar']) {
    assert.ok(compact.includes(id), `compact probes must include #${id}`);
  }
  assert.ok(!compact.includes('quickMenuToggle'), 'compact mode must not probe the hidden wide button');

  const wide = pickProbeTargets(false);
  for (const id of ['quickMenuToggle', 'appVersion', 'updateChip', 'dragBar']) {
    assert.ok(wide.includes(id), `wide probes must include #${id}`);
  }
  assert.ok(!wide.includes('compactMenu'), 'wide mode must not probe the hidden compact button');
  assert.notEqual(compact, pickProbeTargets(true), 'each call returns its own array');
});

// A layout switch leaves the previous layout's hit areas in place for a frame.
// Using those coordinates unclamped put the probe outside the window, where it
// landed on the desktop and looked exactly like an occluding window — the log
// said `dots covered by "Program Manager" (Progman); raising card` as a result.
test('the probe point is always clamped inside the window', () => {
  const compact = { x: 1560, y: 0, width: 360, height: 112 };
  const staleWideAreas = {
    controls: [{ x: 0, y: 0, width: 0, height: 0 }, { x: 568, y: 35, width: 28, height: 28 }],
  };
  const point = defaultHitPoint(compact, staleWideAreas);
  assert.ok(point.x >= compact.x && point.x < compact.x + compact.width, `x ${point.x} escaped the window`);
  assert.ok(point.y >= compact.y && point.y < compact.y + compact.height, `y ${point.y} escaped the window`);
  assert.deepEqual(point, { x: 1560 + 359, y: 49 }, 'a stale wide-layout control clamps to the right edge');
});

test('desktop shells are not treated as occluders', () => {
  const { isDesktopWindow } = require('../src/pointer-diagnostic.cjs');
  for (const cls of ['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd']) {
    assert.equal(isDesktopWindow({ hitTestClass: cls }), true, `${cls} is a desktop shell`);
  }
  for (const cls of ['Chrome_WidgetWin_1', 'WailsWebviewWindow', '', null]) {
    assert.equal(isDesktopWindow({ hitTestClass: cls }), false, `${cls} must not be excluded`);
  }
  assert.equal(isDesktopWindow(null), false);
});
