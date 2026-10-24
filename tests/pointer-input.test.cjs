const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mainHarness } = require('./main-harness.cjs');

function pointerHarness(platform = 'win32') {
  const h = mainHarness({ platform });
  const calls = [];
  let focusable = false;
  let bounds = { x: 100, y: 100, width: 632, height: 432 };
  const window = {
    isDestroyed: () => false,
    isVisible: () => true,
    getBounds: () => ({ ...bounds }),
    setBounds: value => { bounds = { ...bounds, ...value }; },
    getPosition: () => [bounds.x, bounds.y],
    setPosition: (x, y) => { bounds = { ...bounds, x, y }; },
    setIgnoreMouseEvents: value => calls.push(value),
    setFocusable: value => { focusable = value; },
    setAlwaysOnTop() {}, focus() {}, blur() {}, showInactive() {},
    webContents: { send() {}, isDestroyed: () => false },
  };
  h.api.attachWindow(window);
  return { ...h, calls, blocksClicks: () => calls.at(-1) === false, focusable: () => focusable };
}

for (const platform of ['win32', 'darwin']) {
  test(`${platform}: the main panel blocks clicks before hovering a control`, () => {
    const h = pointerHarness(platform);
    h.api.showWindow();
    assert.equal(h.blocksClicks(), true, 'main panel must not pass clicks to the window underneath');
    assert.equal(h.focusable(), false, 'showing the panel must not steal keyboard focus');
  });

  test(`${platform}: leaving a control keeps the panel blocking clicks`, () => {
    const h = pointerHarness(platform);
    h.api.hover(true, 'control');
    assert.equal(h.focusable(), true, 'controls must remain focusable');
    h.api.hover(false);
    assert.equal(h.blocksClicks(), true, 'panel background must still block clicks');
    assert.equal(h.focusable(), false);
  });

  test(`${platform}: closing the quick menu never enables click-through`, () => {
    const h = pointerHarness(platform);
    h.api.menu(true);
    h.api.menu(false);
    assert.equal(h.blocksClicks(), true, 'closing the quick menu must not enable click-through');
    assert.ok(h.calls.every(value => value === false));
  });

  test(`${platform}: settings fade-out never enables click-through`, () => {
    const h = pointerHarness(platform);
    h.api.openPanel();
    assert.equal(h.blocksClicks(), true);
    assert.equal(h.focusable(), true, 'settings must accept keyboard input');
    h.api.closePanel();
    h.runTimeouts();
    assert.equal(h.blocksClicks(), true, 'settings fade-out must not enable click-through');
    assert.equal(h.focusable(), false);
    assert.ok(h.calls.every(value => value === false));
  });

  test(`${platform}: releasing a drag keeps the panel blocking clicks`, () => {
    const h = pointerHarness(platform);
    h.api.startDrag();
    h.api.endDrag();
    assert.equal(h.blocksClicks(), true, 'drag release must not enable click-through');
    assert.ok(h.calls.every(value => value === false));
  });

  test(`${platform}: releasing a resize keeps the panel blocking clicks`, () => {
    const h = pointerHarness(platform);
    h.api.startResize('se');
    h.api.endResize();
    assert.equal(h.blocksClicks(), true, 'resize release must not enable click-through');
    assert.ok(h.calls.every(value => value === false));
  });

  test(`${platform}: ending layout mode keeps the panel blocking clicks`, () => {
    const h = pointerHarness(platform);
    h.api.beginLayout();
    h.api.endLayout();
    assert.equal(h.blocksClicks(), true, 'ending layout must not enable click-through');
    assert.ok(h.calls.every(value => value === false));
  });

  test(`${platform}: compact mode blocks clicks across menu transitions`, () => {
    const h = pointerHarness(platform);
    h.api.toggleCompact();
    h.api.showWindow();
    assert.equal(h.blocksClicks(), true, 'compact panel must block clicks');
    h.api.menu(true);
    h.api.menu(false);
    h.api.hover(false);
    assert.equal(h.blocksClicks(), true);
    assert.ok(h.calls.every(value => value === false));
  });
}
