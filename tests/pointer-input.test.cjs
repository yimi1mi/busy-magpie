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
  // update, another plugin), the explicit focus/taskbar pass must put it back
  // and drop its taskbar tab instead of leaving a stray button behind.
  // This is deliberately NOT a side effect of showWindow()/applyPointerInput():
  // those run up to seventy times a second and rebuilding the native focus and
  // taskbar state that often is what made an idle card stop taking clicks.
  test(`${platform}: a focusable window is put back out of the taskbar`, () => {
    const h = pointerHarness(platform);
    h.setFocusable(true);
    h.api.ensureUnfocusable('test');
    assert.equal(h.focusable(), false, 'the card must be put back to non-focusable');
    assert.deepEqual(h.taskbar, [true], 'the stray taskbar button must be removed');
  });

  test(`${platform}: showing or hovering the window does not rebuild the focus state`, () => {
    const h = pointerHarness(platform);
    h.api.showWindow();
    assert.deepEqual(h.taskbar, [], 'showing the panel must not touch the taskbar');
    h.api.hover(true, 'control');
    h.api.hover(false);
    h.api.hover(true, 'drag');
    h.api.hover(false);
    assert.deepEqual(h.taskbar, [], 'hover must not touch the taskbar either');
    assert.equal(h.focusable(), false, 'the card stays non-focusable');
  });

  test(`${platform}: the confirmed focus state is never rebuilt twice`, () => {
    const h = pointerHarness(platform);
    h.api.ensureUnfocusable('first');
    const afterFirst = h.taskbar.length;
    h.api.ensureUnfocusable('second');
    h.api.ensureUnfocusable('third');
    assert.equal(h.taskbar.length, afterFirst, 'a confirmed window must not be re-set');
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

// A stale `open=true` in the renderer used to swallow every document-level
// pointerdown, killing drag, resize and the dots button at once. The decision
// now lives in a pure module, so that exact split can be reproduced here.
test('a stale open menu never swallows drag, resize or dots clicks', async () => {
  const { shouldDismissMenu } = await import('../web/menu-outside.mjs');
  const target = (...matches) => ({
    closest: (selector) => matches.some((part) => selector.includes(part)) ? {} : null,
  });
  const outsideMenu = { contains: () => false };
  const outsideButton = { contains: () => false };

  assert.equal(shouldDismissMenu(false, target('#card'), outsideMenu, outsideButton), false,
    'a closed menu must never intercept anything');
  for (const [name, node] of [
    ['drag strip', target('.drag-bar', '#card')],
    ['resize handle', target('.resize-handle', '#card')],
    ['menu action', target('[data-menu-action]', '#card')],
    ['compact pill', target('#compactPill', '#card')],
    ['compact expand', target('#compactExpand', '#card')],
    ['compact menu', target('#compactMenu', '#card')],
  ]) {
    assert.equal(shouldDismissMenu(true, node, outsideMenu, outsideButton), false,
      `${name} must keep its own events even while the menu is open`);
  }
  assert.equal(shouldDismissMenu(true, target('#card'), outsideMenu, outsideButton), true,
    'only a click on the cards plain surface dismisses the menu');
  assert.equal(shouldDismissMenu(true, target('#card'), { contains: () => true }, outsideButton), false,
    'a click inside the menu is not an outside click');
  assert.equal(shouldDismissMenu(true, { tagName: 'TEXT' }, outsideMenu, outsideButton), false,
    'a target without closest() is ignored instead of crashing');
});

// Rebuilding the native input state every 70 ms / 1.5 s for hours is what made
// an idle card stop taking clicks. Only real state transitions may write it.
test('the input policy is not rebuilt on hover changes or periodic ticks', () => {
  const h = pointerHarness('win32');
  h.api.showWindow();
  const baseline = h.calls.length;
  assert.equal(baseline, 1, 'show establishes exactly one input baseline');
  h.api.hover(true, 'control');
  h.api.hover(false);
  h.api.hover(true, 'drag');
  h.api.hover(false);
  assert.equal(h.calls.length, baseline, 'hover changes must not call setIgnoreMouseEvents again');
  assert.equal(h.blocksClicks(), true, 'the panel must still block clicks');

  h.api.watchPointerInput();
  const afterWatch = h.calls.length;
  assert.equal(afterWatch, baseline + 1, 'the assertion loop writes its own baseline once');
  h.tick(1500);
  h.tick(1500);
  h.tick(1500);
  assert.equal(h.calls.length, afterWatch, 'periodic ticks must not rebuild the input state');
});

// The card went deaf in the field because Chromium's native occlusion tracker
// decided this transparent toolbar window was covered and cleared WS_VISIBLE on
// Chrome_RenderWidgetHostHWND. Every mouse message then went to the parent
// frame window and the renderer received nothing: requestAnimationFrame kept
// running, elementFromPoint still resolved the button, and the pointerdown
// counters stayed at 0. Same build, two states — the healthy one reported
// IsWindowVisible=True on that child window, the broken one False.
//
// Nothing in our own code can repair that state once it happens, so the
// feature is disabled at startup and the switch is pinned here.
test('native window occlusion calculation stays disabled', () => {
  const h = mainHarness({ platform: 'win32' });
  assert.match(
    h.switches.get('disable-features') || '',
    /CalculateNativeWinOcclusion/,
    'the card must not let Chromium hide its renderer when it looks covered',
  );
});
