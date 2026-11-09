import test from 'node:test';
import assert from 'node:assert/strict';
import { createDragGesture } from '../web/drag-gesture.mjs';

test('pressing and moving past 4px starts the drag without waiting', () => {
  const gesture = createDragGesture();
  assert.equal(gesture.down(100, 20), true);
  assert.equal(gesture.move(101, 21), null, 'jitter inside the threshold stays a click');
  assert.equal(gesture.dragging, false);
  assert.equal(gesture.move(104, 20), 'start', 'the threshold starts the drag immediately');
  assert.equal(gesture.dragging, true);
});

test('holding still for the long-press delay also starts the drag', () => {
  const gesture = createDragGesture();
  assert.equal(gesture.holdMs, 150);
  gesture.down(100, 20);
  assert.equal(gesture.longPress(), 'start');
  assert.equal(gesture.dragging, true);
});

test('a press under the threshold is still reported as a click', () => {
  const gesture = createDragGesture();
  gesture.down(100, 20);
  gesture.move(102, 22);
  gesture.move(98, 18);
  assert.equal(gesture.pressing, true, 'wobbling inside the threshold keeps the press alive');
  assert.equal(gesture.up(), 'click');
  assert.equal(gesture.pressing, false);
  assert.equal(gesture.dragging, false);
});

test('only the primary button arms the gesture', () => {
  const gesture = createDragGesture();
  assert.equal(gesture.down(100, 20, 2), false, 'a right press must not arm a drag');
  assert.equal(gesture.move(200, 200), null);
  assert.equal(gesture.up(), null);
  assert.equal(gesture.down(100, 20, 0), true);
});

test('a started drag cannot be cancelled by moving, only by releasing', () => {
  const gesture = createDragGesture();
  gesture.down(100, 20);
  gesture.move(120, 60);
  assert.equal(gesture.move(300, 300), null, 'further moves must not report a second start');
  assert.equal(gesture.longPress(), null, 'the long-press timer must not restart a running drag');
  assert.equal(gesture.dragging, true);
  assert.equal(gesture.up(), 'dragged');
  assert.equal(gesture.dragging, false);
});

test('the gesture can start again after a release', () => {
  const gesture = createDragGesture();
  gesture.down(0, 0);
  gesture.move(10, 10);
  gesture.up();
  assert.equal(gesture.down(0, 0), true, 'a fresh press must be accepted');
  assert.equal(gesture.move(0, 5), 'start');
  assert.equal(gesture.up(), 'dragged');
});

test('cancelling drops the press without claiming a click', () => {
  const gesture = createDragGesture();
  gesture.down(0, 0);
  gesture.cancel();
  assert.equal(gesture.pressing, false);
  assert.equal(gesture.up(), null);
  assert.equal(gesture.longPress(), null);
});
