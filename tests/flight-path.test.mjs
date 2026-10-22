import test from 'node:test';
import assert from 'node:assert/strict';
import { wireCurve, hubCurve, glideProgress } from '../web/flight-path.mjs';

test('wire geometry is stable and uses the Routing midpoint controls', () => {
  const from = { x: 10, y: 20 }, to = { x: 110, y: 80 };
  assert.equal(wireCurve(from, to), 'M 10 20 C 60 20 60 80 110 80');
  assert.equal(wireCurve(from, to), wireCurve(from, to));
  assert.equal(wireCurve({ x: 10, y: 50 }, { x: 110, y: 50 }), 'M 10 50 C 60 50 60 50 110 50');
});

test('hub crossings and same-side retry turns match Routing geometry', () => {
  assert.equal(hubCurve({ x: 0, y: 20, tx: 1, ty: 0 }, { x: 50, y: 20, tx: 1, ty: 0 }, 50),
    'M 0 20 C 19 14 31 14 50 20');
  assert.equal(hubCurve({ x: 50, y: 20, tx: -1, ty: 0 }, { x: 0, y: 20, tx: -1, ty: 0 }, 50),
    'M 50 20 C 31 26 19 26 0 20');
  assert.equal(hubCurve({ x: 50, y: 20, tx: -1, ty: 0 }, { x: 50, y: 20, tx: 1, ty: 0 }, 50),
    'M 50 20 C 29 7.4 29 32.6 50 20');
});

test('glide starts and lands gently without an extra mid-hub slowdown', () => {
  const samples = [[0, 0], [0.25, 0.1464466094], [0.5, 0.5], [0.75, 0.8535533906], [1, 1]];
  for (const [at, expected] of samples) assert(Math.abs(glideProgress(at) - expected) < 1e-9);
  assert.equal(glideProgress(-1), 0); assert.equal(glideProgress(2), 1);
});
