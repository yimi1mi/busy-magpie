import test from 'node:test';
import assert from 'node:assert/strict';
import { stagedRoutes, wireState, nextRestExpiry, ROUTE_LINGER_MS } from '../web/routing-state.mjs';

const time = Date.UTC(2026, 9, 22, 8);
const request = (id, session, extra = {}) => ({ id, agent: 'codex', session,
  time: new Date(time + id * 100).toISOString(), ms: 1000, done: true,
  order: [{ id: 'a' }], tries: [{ id: 'a', done: true, status: 200 }], ...extra });
const ids = stage => stage.routes.map(route => route.id);

test('completed session cards linger for twelve seconds while the latest remains', () => {
  const a = request(1, 'a'), b = request(2, 'b');
  const expiry = time + 1100 + ROUTE_LINGER_MS;
  assert.deepEqual(ids(stagedRoutes([a, b], new Set(), expiry - 1)), [1, 2]);
  assert.equal(stagedRoutes([a, b], new Set(), expiry - 1).nextExpiry, expiry);
  assert.deepEqual(ids(stagedRoutes([a, b], new Set(), expiry)), [2]);
  assert.deepEqual(ids(stagedRoutes([a, b], new Set(), time + 60000)), [2]);
});

test('active and returning requests stay visible, but newer requests replace old idle group members', () => {
  const a = request(1, 'same'), b = request(2, 'same'), c = request(3, 'other', { done: false });
  assert.deepEqual(ids(stagedRoutes([a, b, c], new Set(), time + 2000)), [2, 3]);
  assert.deepEqual(ids(stagedRoutes([a, b, c], new Set(['1']), time + 60000)), [1, 3]);
});

test('the retention clock uses the recorded completion rather than when the UI heard about it', () => {
  const a = request(1, 'a'), b = request(2, 'b');
  assert.deepEqual(ids(stagedRoutes([a, b], new Set(), time + 120000)), [2]);
  assert.deepEqual(ids(stagedRoutes([{ ...a, time: 'unknown' }, b], new Set(), time)), [2]);
});

test('source and account wires distinguish work, success, failure and return flights', () => {
  const done = request(1, 'a');
  const live = request(2, 'b', { done: false, tries: [{ id: 'a', done: false }] });
  assert.equal(wireState([live], 'in'), 'live'); assert.equal(wireState([live], 'out'), 'live');
  assert.equal(wireState([done], 'in'), 'idle'); assert.equal(wireState([done], 'out'), 'lit');
  assert.equal(wireState([done], 'out', new Set(['1'])), 'live');
  const failed = request(3, 'c', { status: 401, tries: [{ id: 'a', done: true, status: 401 }] });
  assert.equal(wireState([failed], 'out'), 'idle');
});

test('rest expires at the gateway timestamp and a success clears an old candidate rest', () => {
  const until = time + 60000;
  const rested = request(1, 'a', { tries: [{ id: 'a', done: true, status: 429, rest: { until: new Date(until).toISOString() } }] });
  assert.equal(wireState([rested], 'out', new Set(), time), 'rest');
  assert.equal(nextRestExpiry([rested], time), until);
  assert.equal(wireState([rested], 'out', new Set(), until), 'idle');
  const done = request(2, 'b', { order: [{ id: 'a', rest: { until: new Date(until).toISOString() } }] });
  assert.equal(wireState([done], 'out', new Set(), time), 'lit');
  assert.equal(nextRestExpiry([done], time), Infinity);
});

test('folded rows keep active work visible and are resting only when every member rests', () => {
  const until = new Date(time + 60000).toISOString();
  const rested = request(1, 'a', { tries: [{ id: 'a', done: true, status: 429, rest: { until } }] });
  const live = request(2, 'b', { done: false, tries: [{ id: 'b', done: false }] });
  assert.equal(wireState([rested, live], 'out', new Set(), time), 'live');
  assert.equal(wireState([rested, request(3, 'c')], 'out', new Set(), time), 'lit');
  const idle = request(4, 'd', { tries: [] });
  assert.equal(wireState([rested, idle], 'out', new Set(), time), 'idle');
});
