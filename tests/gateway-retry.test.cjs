const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mainHarness } = require('./main-harness.cjs');

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const failure = (kind = 'connect', message = 'fetch failed') => Object.assign(new Error(message),
  kind === 'timeout' ? { name: 'AbortError' } : { cause: { code: 'ECONNREFUSED' } });

test('automatic usage reads back off and log each category once throughout an outage', async () => {
  const h = mainHarness();
  let requests = 0;
  h.setFetch(async () => { requests++; throw failure(requests % 2 ? 'connect' : 'timeout'); });
  for (let i = 0; i < 60; i++) { await h.api.usage(); h.tick(20000); }
  assert.ok(requests < 25, `twenty minutes offline made ${requests} requests`);
  assert.equal(h.logs.filter(line => line.includes('usage unavailable')).length, 2);
  assert.equal(h.api.usageStatus().loading, false);
  assert.ok(h.api.usageStatus().error);
});

test('explicit usage selection bypasses backoff and recovery resets the outage', async () => {
  const h = mainHarness();
  let requests = 0;
  h.setFetch(async () => { requests++; throw failure(); });
  await h.api.usage();
  await h.api.usage();
  assert.equal(requests, 1, 'a background poll must honor backoff');
  h.setFetch(async () => ({ ok: true, json: async () => ({ input: 7 }) }));
  assert.equal((await h.period('7d')).ok, true, 'a user action must retry immediately');
  assert.equal(h.logs.filter(line => line.includes('usage recovered')).length, 1);
  h.setFetch(async () => { throw failure(); });
  await h.api.usage();
  assert.equal(h.logs.filter(line => line.includes('usage unavailable')).length, 2,
    'a new outage must be reported after success');
});

test('a different gateway bypasses an old outage backoff', async () => {
  const h = mainHarness();
  const urls = [];
  h.setFetch(async url => { urls.push(url); throw failure(); });
  await h.api.usage();
  h.api.settings().gateway = 'http://127.0.0.1:3500';
  await h.api.usage();
  assert.equal(urls.length, 2);
  assert.match(urls[1], /:3500/);
});

test('trace alternations stay deduplicated and backoff outgrows five seconds', async () => {
  const h = mainHarness();
  let requests = 0;
  h.setFetch(async () => { requests++; throw failure(requests % 2 ? 'connect' : 'timeout', `failure ${requests}`); });
  const client = h.api.traceClient('http://127.0.0.1:3425');
  const loop = client.loop();
  const waits = [];
  for (let i = 0; i < 12; i++) { await flush(); waits.push(h.runNextTimeout()); }
  await flush();
  assert.ok(waits.at(-1) >= 60000, `retry waits were ${waits}`);
  assert.equal(h.logs.filter(line => line.includes('trace unavailable')).length, 2);
  client.stop();
  h.runTimeouts();
  await loop;
});

test('stopping or reconnecting interrupts a trace retry wait', async () => {
  const h = mainHarness();
  let requests = 0;
  h.setFetch(async () => { requests++; throw failure(); });
  const client = h.api.traceClient('http://127.0.0.1:3425');
  const loop = client.loop();
  await flush();
  client.reconnect();
  await flush();
  assert.equal(requests, 2, 'manual reconnect must wake a pending backoff');
  client.stop();
  await flush();
  assert.deepEqual(h.pendingTimeouts, [], 'stop must cancel the pending retry and read timeout');
  await loop;
});

test('changing error messages share a category while distinct HTTP failures remain visible', async () => {
  const h = mainHarness();
  const errors = [new TypeError('fetch failed'), new TypeError('network socket changed'),
    Object.assign(new Error('denied'), { status: 401 }),
    Object.assign(new Error('unavailable'), { status: 503 }), new TypeError('fetch failed again')];
  for (const error of errors) {
    h.setFetch(async () => { throw error; });
    await h.period('7d');
  }
  assert.equal(h.logs.filter(line => line.includes('usage unavailable')).length, 3,
    'one connection category and each distinct HTTP status are reported');
});

test('a long failed read followed by backoff does not trigger the trace watchdog', async () => {
  const h = mainHarness();
  let rejectRead;
  h.setFetch(() => new Promise((resolve, reject) => { rejectRead = reject; }));
  const client = h.api.traceClient('http://127.0.0.1:3425');
  h.api.watchTrace(client);
  let loop = client.loop();
  // Reach the maximum backoff with quick failures first.
  for (let i = 0; i < 6; i++) {
    rejectRead(failure()); await flush(); h.runNextTimeout(); await flush();
  }
  h.tick(40000);
  rejectRead(failure('timeout')); await flush();
  h.tick(30000);
  assert.equal(h.logs.filter(line => line.includes('trace loop stalled')).length, 0);
  assert.equal(client.idleFor(), 0, 'the client is deliberately waiting');
  client.stop(); await flush(); await loop;
});

test('trace recovery logs once, resets backoff, and permits a new outage report', async () => {
  const h = mainHarness();
  let mode = 'failed', hold;
  h.setFetch(() => mode === 'failed' ? Promise.reject(failure())
    : mode === 'success' ? Promise.resolve({ ok: true, json: async () => {
      mode = 'hold'; return { pid: 1, seq: 1, routes: [] };
    } }) : new Promise((resolve, reject) => { hold = reject; }));
  const client = h.api.traceClient('http://127.0.0.1:3425');
  const loop = client.loop();
  await flush();
  mode = 'success'; h.runNextTimeout(); await flush();
  assert.equal(h.logs.filter(line => line.includes('trace recovered')).length, 1);
  hold(failure()); await flush();
  assert.equal(h.logs.filter(line => line.includes('trace unavailable')).length, 2);
  assert.ok(h.pendingTimeouts.includes(1000), 'the new outage starts with the shortest retry');
  client.stop(); await flush(); await loop;
});
