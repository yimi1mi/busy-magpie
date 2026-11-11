const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mainHarness } = require('./main-harness.cjs');

function recoveryHarness() {
  let state = { supported: true, clickThrough: false, regionKind: 'NO_REGION',
    hitTestOwnsPoint: false, hitTestWindow: '42', hitTestClass: 'Chrome_WidgetWin_1' };
  const h = mainHarness({ pointerState: () => ({ ...state }) });
  const calls = { raises: 0, reveals: 0, input: 0 };
  h.api.attachWindow({
    isDestroyed: () => false, isVisible: () => true, isFocusable: () => false,
    getBounds: () => ({ x: 100, y: 100, width: 632, height: 432 }),
    setIgnoreMouseEvents() { calls.input++; },
    setFocusable() {}, setSkipTaskbar() {}, setAlwaysOnTop() {},
    moveTop() { calls.raises++; }, hide() {}, showInactive() { calls.reveals++; },
    webContents: { send() {}, isDestroyed: () => false },
  });
  h.api.watchPointerInput();
  return { ...h, calls, state: value => { state = { ...state, ...value }; },
    probe() { for (let i = 0; i < 20; i++) h.tick(1500); } };
}

test('persistent lost ownership stops raising and rebuilding input after one attempt', () => {
  const h = recoveryHarness();
  for (let i = 0; i < 120; i++) h.probe();
  assert.equal(h.calls.raises, 1, 'an hour under the same window must not cause periodic raises');
  assert.equal(h.calls.input, 2, 'only the baseline and one recovery may rebuild input');
  assert.equal(h.logs.filter(line => line.includes('raising card')).length, 1);
  assert.equal(h.logs.filter(line => line.includes('occlusion result')).length, 1,
    'record whether the attempted raise restored ownership');
});

test('changing foreign handles and inconclusive desktop hits do not rearm recovery', () => {
  const h = recoveryHarness();
  for (let i = 0; i < 12; i++) {
    h.state({ hitTestWindow: String(42 + i), hitTestClass: 'Chrome_WidgetWin_1' });
    h.probe();
    h.state({ hitTestClass: 'WorkerW' });
    h.probe();
  }
  assert.equal(h.calls.raises, 1);
});

test('confirmed ownership rearms recovery for a later loss', () => {
  const h = recoveryHarness();
  h.probe();
  h.state({ hitTestOwnsPoint: true });
  h.probe();
  h.state({ hitTestOwnsPoint: false });
  h.probe();
  assert.equal(h.calls.raises, 2, 'a separate failure still gets a recovery attempt');
});

test('no-owner reveal is also bounded until ownership is confirmed', () => {
  const h = recoveryHarness();
  h.state({ hitTestWindow: '0', hitTestClass: '' });
  for (let i = 0; i < 20; i++) h.probe();
  assert.equal(h.calls.reveals, 1, 'an ineffective reveal must not repeat every minute');
});

test('a native click-through fault still repairs even after an inconclusive raise', () => {
  const h = recoveryHarness();
  h.probe();
  const before = h.calls.input;
  h.state({ clickThrough: true });
  h.probe();
  assert.equal(h.calls.input, before + 1);
});
