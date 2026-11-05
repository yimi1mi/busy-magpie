const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mainHarness } = require('./main-harness.cjs');

const COMPACT_WIDTH = 360;
const COMPACT_HEIGHT = 112;

// A position far from the work area edges, so clampBounds cannot mask the
// anchoring: every number asserted below is the app's own decision.
function compactHarness(initial) {
  const h = mainHarness();
  let bounds = { ...initial };
  const window = {
    isDestroyed: () => false,
    isVisible: () => true,
    getBounds: () => ({ ...bounds }),
    setBounds: value => { bounds = { ...bounds, ...value }; },
    getPosition: () => [bounds.x, bounds.y],
    setPosition: (x, y) => { bounds = { ...bounds, x, y }; },
    setIgnoreMouseEvents() {},
    isFocusable: () => false,
    setFocusable() {},
    setSkipTaskbar() {},
    setAlwaysOnTop() {},
    focus() {},
    blur() {},
    showInactive() {},
    webContents: { send() {}, isDestroyed: () => false },
  };
  h.api.attachWindow(window);
  return { h, bounds: () => ({ ...bounds }) };
}

test('folding to compact mode keeps the wide card right edge in place', () => {
  const { h, bounds } = compactHarness({ x: 300, y: 300, width: 632, height: 432 });
  const wide = bounds();
  h.api.toggleCompact();
  const compact = bounds();
  assert.equal(compact.width, COMPACT_WIDTH);
  assert.equal(compact.height, COMPACT_HEIGHT);
  assert.equal(compact.x + compact.width, wide.x + wide.width, 'the compact strip must end where the card ended');
  assert.equal(compact.y, wide.y, 'folding must not move the card vertically');
});

test('expanding keeps the left edge where the compact strip was', () => {
  const { h, bounds } = compactHarness({ x: 300, y: 300, width: 632, height: 432 });
  h.api.toggleCompact();
  const compact = bounds();
  h.api.toggleCompact();
  const expanded = bounds();
  assert.equal(expanded.x, compact.x, 'expanding must not slide the window');
  assert.equal(expanded.width, h.api.settings().width);
  assert.equal(expanded.height, h.api.settings().height);
});

test('each fold anchors on the right edge the window has at that moment', () => {
  const { h, bounds } = compactHarness({ x: 300, y: 300, width: 632, height: 432 });
  for (let cycle = 0; cycle < 3; cycle++) {
    const wide = bounds();
    h.api.toggleCompact();
    const compact = bounds();
    assert.equal(compact.x + compact.width, wide.x + wide.width, `cycle ${cycle}: right edge must stay put`);
    assert.equal(compact.y, wide.y, `cycle ${cycle}: folding must not move vertically`);
    h.api.toggleCompact();
    const expanded = bounds();
    assert.equal(expanded.x, compact.x, `cycle ${cycle}: expanding keeps the left edge`);
    assert.ok(expanded.x + expanded.width <= 1920, `cycle ${cycle}: the card must stay inside the work area`);
  }
});
