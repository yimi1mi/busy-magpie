const { test } = require('node:test');
const assert = require('node:assert/strict');
const { shapeRegion, createRegionShaper } = require('../shell/windows-blur.cjs');

// A fake window whose size the test drives. `setShape` records every region it
// was handed, so a test can prove that a bad size never reaches Windows.
function fakeWindow(initial = [632, 432]) {
  let size = [...initial];
  let dpi = 96;
  const shapes = [];
  return {
    shapes,
    setSize(next) { size = [...next]; },
    setDpi(next) { dpi = next; },
    make(logger) {
      return createRegionShaper({
        getSize: () => [...size],
        getDpi: () => dpi,
        setShape: (rects) => shapes.push(rects),
        logger,
      });
    },
  };
}

const area = rects => rects.reduce((sum, r) => sum + r.width * r.height, 0);

test('a plausible card size yields a rounded mask that covers most of its area', () => {
  const shape = shapeRegion(632, 432);
  assert.ok(Array.isArray(shape) && shape.length > 0);
  assert.ok(shape.every(rect => rect.width > 0 && rect.height > 0), 'every band must have area');
  // Rounded corners clip something, but the shape must stay nearly complete.
  assert.ok(area(shape) > 632 * 432 * 0.98, 'the mask must cover the card');
});

test('a zero-size window never reaches setShape', () => {
  const win = fakeWindow([632, 432]);
  const shaper = win.make();
  shaper.clip(true);
  const before = win.shapes.length;
  assert.ok(before > 0, 'the first real build installs a region');

  win.setSize([0, 0]);
  shaper.clip(true);
  assert.equal(win.shapes.length, before, 'a 0x0 window must not install a region');

  win.setSize([0, 432]);
  shaper.clip(true);
  assert.equal(win.shapes.length, before, 'a zero width must not install a region');

  win.setSize([632, 0]);
  shaper.clip(true);
  assert.equal(win.shapes.length, before, 'a zero height must not install a region');
});

test('a recovered size rebuilds the region even though the cached key was skipped', () => {
  const win = fakeWindow([632, 432]);
  const shaper = win.make();
  shaper.clip(true);
  const first = win.shapes.at(-1);
  assert.equal(win.shapes.length, 1, 'the first build installs one region');

  win.setSize([0, 0]);
  shaper.clip();            // cache key cleared here
  assert.equal(win.shapes.length, 1, 'the unusable size installs nothing');

  win.setSize([632, 432]);
  shaper.clip();            // must rebuild despite the unchanged size
  assert.equal(win.shapes.length, 2, 'the recovered size must install a new region');
  assert.deepEqual(win.shapes.at(-1), first, 'and it must be the same shape as before');
});

test('a skipped rebuild keeps working when the logger throws', () => {
  const win = fakeWindow([0, 0]);
  const shaper = win.make(() => { throw new Error('log is unavailable'); });
  assert.doesNotThrow(() => shaper.clip(true), 'a broken logger must not escape clip()');
  assert.equal(win.shapes.length, 0);
});

test('the skip breadcrumb is throttled to one line a minute', () => {
  const lines = [];
  let clock = 1_000_000;
  const calls = [];
  const shaper = createRegionShaper({
    getSize: () => [0, 0],
    getDpi: () => 96,
    setShape: (rects) => calls.push(rects),
    logger: (line) => lines.push(line),
    now: () => clock,
  });

  shaper.clip(true);
  shaper.clip(true);
  shaper.clip(true);
  assert.equal(lines.length, 1, 'repeated skips inside a minute log once');

  clock += 61_000;
  shaper.clip(true);
  assert.equal(lines.length, 2, 'a later skip logs again');
  assert.match(lines[0], /blur region: skipped \(0x0\)/);
  assert.equal(calls.length, 0, 'no region may be installed while the size is unusable');
});

test('a one-pixel window degrades to one solid rectangle instead of a blank shape', () => {
  // radius is clamped to at least 1, so 2*radius exceeds a 1px dimension and
  // the rounded path could only produce bands with no height.
  const shape = shapeRegion(1, 10);
  assert.deepEqual(shape, [{ x: 0, y: 0, width: 1, height: 10 }]);
  assert.ok(area(shape) > 0, 'even a degenerate card must stay clickable');
});

test('any shape the builder returns has a non-zero area', () => {
  for (const [w, h] of [[632, 432], [360, 112], [10, 10], [1, 10], [10, 1], [2, 2], [3, 500]]) {
    const shape = shapeRegion(w, h);
    assert.ok(Array.isArray(shape) && shape.length > 0, `${w}x${h} must produce a shape`);
    assert.ok(shape.every(rect => rect.width > 0 && rect.height > 0), `${w}x${h} bands must have area`);
    assert.ok(area(shape) > 0, `${w}x${h} must not be a blank region`);
  }
});

test('an unchanged size is not rebuilt unless the caller forces it', () => {
  const win = fakeWindow([632, 432]);
  const shaper = win.make();
  shaper.clip();
  shaper.clip();
  shaper.clip();
  assert.equal(win.shapes.length, 1, 'the size cache must avoid redundant setShape calls');
  shaper.clip(true);
  assert.equal(win.shapes.length, 2, 'force must rebuild regardless of the cache');
});
