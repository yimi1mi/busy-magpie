import test from 'node:test';
import assert from 'node:assert/strict';
import { RequestFlight, FlightBook } from '../web/flight-playback.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const request = (id = 1, extra = {}) => ({ id, done: false, tries: [{ id: 'a', done: false }], ...extra });
function run(route) {
  const session = new RequestFlight(route), events = [];
  const finished = session.play(async move => events.push(move), place => events.push({ hold: place }));
  return { session, events, finished };
}

test('an unfinished request waits for its real result without another flight', async () => {
  const { session, events, finished } = run(request());
  await tick();
  assert.deepEqual(events, [{ from: 'agent', to: 'account', attempt: 0, ms: 1400, error: false }, { hold: 'account' }]);
  session.update(request(1, { tries: [{ id: 'a', done: true, status: 200 }] }));
  await tick();
  assert.equal(events.length, 2, 'a successful attempt still waits for route completion');
  session.update(request(1, { done: true, tries: [{ id: 'a', done: true, status: 200 }] }));
  await finished;
  assert.deepEqual(events.at(-1), { from: 'account', to: 'agent', attempt: 0, ms: 1400, error: false });
});

test('selection waits at magpie and each retry returns there before the next attempt', async () => {
  const { session, events, finished } = run(request(1, { tries: [] }));
  await tick();
  assert.deepEqual(events.map(e => e.to || e.hold), ['hub', 'hub']);
  session.update(request(1, { tries: [{ id: 'a', done: true, status: 429, rest: { seconds: 60 } }] }));
  await tick();
  assert.deepEqual(events.filter(e => e.to).map(e => [e.from, e.to]), [['agent', 'hub'], ['hub', 'account'], ['account', 'hub']]);
  session.update(request(1, { done: true, tries: [
    { id: 'a', done: true, status: 429, rest: { seconds: 60 } },
    { id: 'b', done: true, status: 200 },
  ] }));
  await finished;
  assert.deepEqual(events.filter(e => e.to).slice(-2).map(e => [e.from, e.to, e.attempt]), [['hub', 'account', 1], ['account', 'agent', 1]]);
});

test('already-completed retries at the same account each play once', async () => {
  const { events, finished } = run(request(1, { done: true, tries: [
    { id: 'a', done: true, status: 503, again: true },
    { id: 'a', done: true, status: 200 },
  ] }));
  await finished;
  assert.deepEqual(events.filter(e => e.to).map(e => [e.from, e.to, e.attempt]), [
    ['agent', 'account', 0], ['account', 'hub', 0], ['hub', 'account', 1], ['account', 'agent', 1],
  ]);
});

test('terminal failures return to the agent and cancellation never fabricates an answer', async () => {
  const failed = run(request(1, { done: true, tries: [{ id: 'a', done: true, status: 401 }] }));
  await failed.finished;
  assert.deepEqual(failed.events.at(-1), { from: 'account', to: 'agent', attempt: 0, ms: 1350, error: true });
  const waiting = run(request());
  await tick(); waiting.session.cancel(); await waiting.finished;
  assert.equal(waiting.events.filter(e => e.to === 'agent').length, 0);
  assert.equal(waiting.session.waiters.size, 0);
});

test('history is quiet, fresh completed requests play, and duplicate snapshots do not replay', () => {
  const book = new FlightBook();
  const history = request(1, { done: true, tries: [{ done: true, status: 200 }] });
  book.update({ pid: 4, seq: 1, routes: [history] }, true);
  assert.equal(book.sessions.size, 0);
  const fresh = { ...history, id: 2 };
  book.update({ pid: 4, seq: 2, routes: [history, fresh] }, true);
  assert.equal(book.sessions.size, 1);
  const session = book.sessions.get('2');
  book.update({ pid: 4, seq: 2, routes: [history, fresh] }, true);
  assert.equal(book.sessions.get('2'), session);
  book.finish(session);
  book.update({ pid: 4, seq: 2, routes: [history, fresh] }, true);
  assert.equal(book.sessions.size, 0);
});

test('all requests keep independent flights and a restart cannot reuse old request identities', () => {
  const book = new FlightBook();
  const routes = [1, 2, 3, 4, 5, 6].map(id => request(id, { agent: 'codex', session: 'same' }));
  book.update({ pid: 4, seq: 20, routes }, true);
  assert.equal(book.sessions.size, 6);
  const old = book.sessions.get('1');
  book.update({ pid: 5, seq: 1, routes: [request()] }, true);
  assert.equal(old.active, false);
  assert.notEqual(book.sessions.get('1'), old);
  book.finish(old);
  assert.equal(book.sessions.size, 1);
});

test('quiet mode cancels flights and resumes only requests still active', () => {
  const book = new FlightBook();
  book.update({ pid: 1, seq: 1, routes: [request()] }, true);
  const first = book.sessions.get('1');
  book.update({ pid: 1, seq: 2, routes: [request()] }, false);
  assert.equal(first.active, false);
  const done = request(2, { done: true, tries: [{ done: true, status: 200 }] });
  book.update({ pid: 1, seq: 3, routes: [request(), done] }, false);
  book.update({ pid: 1, seq: 3, routes: [request(), done] }, true);
  assert.deepEqual([...book.sessions.keys()], ['1']);
  book.update({ pid: 1, seq: 4, routes: [] }, true);
  assert.equal(book.sessions.size, 0);
});
