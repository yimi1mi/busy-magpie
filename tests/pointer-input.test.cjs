const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mainHarness } = require('./main-harness.cjs');

function pointerHarness(platform = 'win32') {
  const h = mainHarness({ platform });
  const calls = [];
  const taskbar = [];
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
    isFocusable: () => focusable,
    setFocusable: value => { focusable = value; },
    setSkipTaskbar: value => { taskbar.push(value); },
    setAlwaysOnTop() {}, focus() {}, blur() {}, showInactive() {},
    webContents: { send() {}, isDestroyed: () => false },
  };
  h.api.attachWindow(window);
  return {
    ...h,
    calls,
    taskbar,
    blocksClicks: () => calls.at(-1) === false,
    focusable: () => focusable,
    setFocusable: value => { focusable = value; },
  };
}

for (const platform of ['win32', 'darwin']) {
  test(`${platform}: the main panel blocks clicks before hovering a control`, () => {
    const h = pointerHarness(platform);
    h.api.showWindow();
    assert.equal(h.blocksClicks(), true, 'main panel must not pass clicks to the window underneath');
    assert.equal(h.focusable(), false, 'showing the panel must not steal keyboard focus');
    assert.deepEqual(h.taskbar, [], 'showing the panel must not touch the taskbar');
  });

  // Electron's setFocusable(true) also calls SetSkipTaskbar(false) on Windows,
  // which runs ITaskbarList::AddTab. Hover is a 70 ms poll, so flipping
  // focusability there made the taskbar button flash and pulled the foreground
  // away from other applications. The hover path must never become focusable.
  test(`${platform}: hovering a control never makes the card focusable`, () => {
    const h = pointerHarness(platform);
    h.api.hover(true, 'control');
    h.api.hover(false);
    h.api.hover(true, 'drag');
    h.api.hover(false);
    h.api.hover(true, 'resize');
    h.api.hover(false);
    assert.equal(h.focusable(), false, 'hover must never make the card activatable');
    assert.ok(h.calls.every(value => value === false), 'hover must not enable click-through');
    assert.deepEqual(h.taskbar, [], 'hover must never add a taskbar button');
  });

  test(`${platform}: closing the quick menu never enables click-through`, () => {
    const h = pointerHarness(platform);
    h.api.menu(true);
    h.api.menu(false);
    assert.equal(h.blocksClicks(), true, 'closing the quick menu must not enable click-through');
    assert.ok(h.calls.every(value => value === false));
    assert.equal(h.focusable(), false, 'the quick menu must not take keyboard focus');
    assert.deepEqual(h.taskbar, [], 'the quick menu must never add a taskbar button');
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
    assert.ok(h.taskbar.every(value => value === true),
      'closing settings must keep the window out of the taskbar');
  });

  test(`${platform}: releasing a drag keeps the panel blocking clicks`, () => {
    const h = pointerHarness(platform);
    h.api.startDrag();
    assert.equal(h.focusable(), false, 'dragging must not take keyboard focus');
    h.api.endDrag();
    assert.equal(h.blocksClicks(), true, 'drag release must not enable click-through');
    assert.equal(h.focusable(), false);
    assert.ok(h.calls.every(value => value === false));
    assert.deepEqual(h.taskbar, [], 'dragging must never add a taskbar button');
  });

  test(`${platform}: releasing a resize keeps the panel blocking clicks`, () => {
    const h = pointerHarness(platform);
    h.api.startResize('se');
    assert.equal(h.focusable(), false, 'resizing must not take keyboard focus');
    h.api.endResize();
    assert.equal(h.blocksClicks(), true, 'resize release must not enable click-through');
    assert.equal(h.focusable(), false);
    assert.ok(h.calls.every(value => value === false));
    assert.deepEqual(h.taskbar, [], 'resizing must never add a taskbar button');
  });

  test(`${platform}: ending layout mode keeps the panel blocking clicks`, () => {
    const h = pointerHarness(platform);
    h.api.beginLayout();
    assert.equal(h.focusable(), false, 'layout mode must not take keyboard focus');
    h.api.endLayout();
    assert.equal(h.blocksClicks(), true, 'ending layout must not enable click-through');
    assert.equal(h.focusable(), false);
    assert.ok(h.calls.every(value => value === false));
    assert.deepEqual(h.taskbar, [], 'layout mode must never add a taskbar button');
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
    assert.equal(h.focusable(), false);
  });

  // Defensive net: if anything leaves the window focusable (an Electron
  // update, another plugin), the next state change must put it back and drop
  // its taskbar tab instead of leaving a stray button behind.
  test(`${platform}: a focusable window is put back out of the taskbar`, () => {
    const h = pointerHarness(platform);
    h.setFocusable(true);
    h.api.showWindow();
    assert.equal(h.focusable(), false, 'the card must be put back to non-focusable');
    assert.deepEqual(h.taskbar, [true], 'the stray taskbar button must be removed');
  });

  // A dots click that arrives while the settings pane is fading out used to be
  // dropped by a silent guard. It is now parked and replayed once the pane has
  // closed, so the click the user made is the click that opens the menu.
  test(`${platform}: opening the menu closes the settings pane instead of failing`, () => {
    const h = pointerHarness(platform);
    h.api.openPanel();
    h.api.menu(true);
    assert.equal(h.api.menuPending(), true, 'the open request is parked while the pane fades');
    h.runTimeouts();
    assert.equal(h.api.menuOpen(), true, 'the parked request opens the menu once the pane is gone');
    assert.equal(h.blocksClicks(), true, 'the card must keep blocking clicks');
  });

  // The input policy used to be reasserted only by the hover poll, which every
  // open mode suppressed. The assertion loop does it regardless of mode.
  test(`${platform}: the assertion loop keeps the panel blocking clicks`, () => {
    const h = pointerHarness(platform);
    h.api.watchPointerInput();
    h.tick(1500);
    assert.equal(h.blocksClicks(), true, 'the periodic assertion must keep clicks blocked');
    assert.equal(h.focusable(), false, 'the periodic assertion must not steal focus');
  });

  // Locking the screen or suspending the machine resets input state at the
  // compositor level. Both events must reassert the policy.
  test(`${platform}: waking the machine reasserts the input policy`, () => {
    const h = pointerHarness(platform);
    h.api.watchPowerEvents();
    h.powerMonitor.emit('resume');
    h.powerMonitor.emit('unlock-screen');
    assert.equal(h.blocksClicks(), true, 'resume must not leave the card click-through');
    assert.ok(h.calls.every(value => value === false), 'resume must never enable click-through');
  });
}
