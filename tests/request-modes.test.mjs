import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectRequestModes, latestModeRoute } from '../web/request-modes.mjs';
import { groupRequests } from '../web/request-model.mjs';

const route = (id, fields = {}) => ({ id, agent: 'codex', provider: 'openai', session: 'chat',
  time: `2026-10-22T00:00:${String(id).padStart(2, '0')}Z`, done: false, ...fields });

test('own-signin trace can show requested Fast without inventing a sent or reported tier', () => {
  const modes = projectRequestModes(route(1, { effort: 'xhigh', tier: 'priority', tries: [{ effort: 'xhigh' }] }));
  assert.equal(modes.speedLabel, 'Fast 请求');
  assert.equal(modes.speedKind, 'fast');
  assert.equal(modes.effortLabel, 'xhigh');
  assert.deepEqual(modes.source, { speed: 'asked', effort: 'sent' });
  assert.equal(modes.sentTier, '');
  assert.equal(modes.reportedTier, '');
  assert.match(modes.details, /服务端档位回报：未提供/);
});

test('reported default or auto is not replaced by a requested Fast tier', () => {
  for (const tierServed of ['default', 'auto']) {
    const modes = projectRequestModes(route(1, { tier: 'priority', tries: [{ tier: 'priority', tierServed }] }));
    assert.equal(modes.speedLabel, `${tierServed} 回报`);
    assert.equal(modes.speedKind, 'other');
    assert.equal(modes.source.speed, 'reported');
    assert.equal(modes.requestSpeedKind, 'fast');
    assert.equal(modes.requestSpeedValue, 'priority');
    assert.equal(modes.requestSource.speed, 'asked');
    assert.match(modes.details, /速度档位请求：priority（Fast）/);
    assert.match(modes.details, /发送速度档位：priority（Fast）/);
  }
});

test('ultrafast speed and ultra effort remain independent, including fitted effort', () => {
  const modes = projectRequestModes(route(1, { tier: 'ultrafast', effort: 'ultra', tries: [{ effort: 'max' }] }));
  assert.equal(modes.speedLabel, 'Ultrafast 请求');
  assert.equal(modes.effortLabel, 'ultra → max');
  assert.equal(modes.effortValue, 'max');
  assert.equal(modes.askedEffort, 'ultra');
  assert.equal(modes.requestEffortValue, 'ultra');
  assert.equal(modes.requestSource.effort, 'asked');
});

test('an agent brand alone never converts another providers priority tier into Fast', () => {
  for (const provider of ['anthropic', 'relay', '']) {
    const modes = projectRequestModes(route(1, { provider, tier: 'priority', tries: [{ tier: 'priority', tierServed: 'priority' }] }));
    assert.equal(modes.speedLabel, 'priority 回报');
    assert.equal(modes.speedKind, 'other');
    assert.match(modes.details, /未确认是 OpenAI Fast/);
  }
});

test('fallback tier meaning uses its actual candidate provider, not the original provider', () => {
  const modes = projectRequestModes(route(1, { tier: 'priority', group: { id: 'fallback' },
    order: [{ id: 'a', provider: 'openai' }, { id: 'b', provider: 'anthropic' }],
    tries: [{ id: 'a', tier: 'priority', tierServed: 'priority' }, { id: 'b', tierServed: 'priority' }] }));
  assert.equal(modes.speedLabel, 'priority 回报');
  assert.equal(modes.speedKind, 'other');
  assert.match(modes.details, /不代表 Claude 的 usage.speed/);
  const unknown = projectRequestModes(route(1, { group: { id: 'fallback' }, tries: [{ id: 'missing', tierServed: 'priority' }] }));
  assert.equal(unknown.speedLabel, 'priority 回报');
});

test('explicit fast is a request or sent observation; Try.fast alone is not a speed measurement', () => {
  const planned = projectRequestModes(route(1, { tries: [{ fast: true }] }));
  assert.equal(planned.speedLabel, '');
  assert.equal(planned.speedKind, '');
  assert.equal(planned.hasData, false);
  assert.equal(planned.requestSpeedKind, '');
  assert.match(planned.details, /不证明已发送或实际采用 Fast/);
  const sent = projectRequestModes(route(1, { provider: 'anthropic', tier: 'fast', tries: [{ tier: 'fast' }] }));
  assert.equal(sent.speedLabel, 'Fast 已发送');
  assert.equal(sent.source.speed, 'sent');
});

test('request configuration falls back only to this attempts sent fields, never its reported tier', () => {
  const modes = projectRequestModes(route(1, { tries: [{ effort: 'high', tier: 'priority', tierServed: 'default' }] }));
  assert.equal(modes.requestSpeedKind, 'fast');
  assert.equal(modes.requestEffortValue, 'high');
  assert.deepEqual(modes.requestSource, { speed: 'sent', effort: 'sent' });
  const reportedOnly = projectRequestModes(route(1, { tries: [{ tierServed: 'priority' }] }));
  assert.equal(reportedOnly.speedKind, 'fast');
  assert.equal(reportedOnly.requestSpeedKind, '');
  assert.equal(reportedOnly.requestSpeedValue, '');
});

test('missing, none, minimal and new effort words stay distinct without inferred budgets or defaults', () => {
  assert.equal(projectRequestModes(null).hasData, false);
  assert.equal(projectRequestModes({}).effortValue, '');
  for (const effort of ['none', 'minimal', 'new-level']) {
    const modes = projectRequestModes({ effort });
    assert.equal(modes.effortValue, effort);
    assert.equal(modes.source.effort, 'asked');
  }
  const unknown = projectRequestModes({ tier: 'new-tier', reasoning: 50000, ms: 1 });
  assert.equal(unknown.speedLabel, 'new-tier 请求');
  assert.equal(unknown.speedKind, 'other');
  assert.equal(unknown.effortLabel, '');
});

test('the current attempt owns the projected result, without borrowing fields from failed attempts', () => {
  const modes = projectRequestModes(route(1, { effort: 'xhigh', tries: [
    { effort: 'xhigh', tier: 'priority', tierServed: 'priority', done: true, status: 429 },
    { effort: 'low', done: false },
  ] }));
  assert.equal(modes.effortLabel, 'xhigh → low');
  assert.equal(modes.speedLabel, '');
  assert.equal(modes.reportedTier, '');
});

test('a reused candidate ID matches the current model before selecting provider semantics', () => {
  const modes = projectRequestModes(route(1, { group: { id: 'fallback' },
    order: [{ id: 'same', model: 'a', provider: 'openai' }],
    left: [{ id: 'same', model: 'b', provider: 'anthropic' }],
    tries: [{ id: 'same', model: 'b', tierServed: 'priority' }] }));
  assert.equal(modes.speedKind, 'other');
});

test('latest ordinary request supplies modes without changing the flight representative', () => {
  const first = route(1, { effort: 'high', tier: 'priority' });
  const current = route(2, { effort: 'xhigh' });
  const kinds = ['guardian', 'guardian_review', 'thread_title', 'thread_title_reconsideration',
    'title_generation', 'thread_description', 'composer_predictions', 'ambient_suggestions',
    'ambient_suggestion_safety', 'memory_consolidation', 'memgen', 'routing', 'vision', 'web_search', 'compact', 'new_helper'];
  for (const kind of kinds) {
    const [group] = groupRequests([route(3, { kind, effort: 'low' }), current, first]);
    assert.equal(group.route, first);
    assert.equal(group.modeRoute, current, kind);
    assert.equal(group.modes.effortLabel, 'xhigh', kind);
    assert.equal(group.modes.speedLabel, '', 'a new unmarked turn must not inherit old Fast');
  }
});

test('auxiliary-only groups do not establish conversation modes', () => {
  for (const fields of [{ kind: 'guardian' }, { for: { agent: 'codex' } }]) {
    const [group] = groupRequests([route(1, { effort: 'low', ...fields })]);
    assert.equal(group.modeRoute, null);
    assert.equal(group.modes.hasData, false);
  }
});

test('collaboration has its own identity and does not overwrite a parent sharing its identity', () => {
  const parent = route(1, { effort: 'xhigh' });
  const child = route(2, { session: 'child', kind: 'collab_spawn', effort: 'high' });
  const groups = groupRequests([parent, child]);
  assert.equal(groups.find(group => group.session === 'child').modes.effortValue, 'high');
  assert.equal(groups.find(group => group.session === 'chat').modes.effortValue, 'xhigh');
  assert.equal(latestModeRoute([parent, { ...child, session: 'chat' }]), parent);
});

test('unidentified requests get independent groups and never claim a shared conversation mode', () => {
  const rows = [route(1, { session: '', effort: 'high' }), route(2, { session: '', tier: 'priority' })];
  const groups = groupRequests(rows);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].routes.length, 1);
  assert.equal(groups[0].modes.effortValue, 'high');
  assert.equal(groups[0].modes.speedLabel, '');
  assert.equal(groups[1].modes.effortValue, '');
  assert.equal(groups[1].modes.speedLabel, 'Fast 请求');
  assert.equal(latestModeRoute(rows), null);
  assert.equal(projectRequestModes(rows[1]).speedLabel, 'Fast 请求');
  assert.equal(groupRequests([rows[0]])[0].modes.effortValue, 'high');
  assert.equal(groupRequests(rows.map(row => ({ ...row, conv: 'known' })))[0].modeRoute.id, 2);
});

test('selection is stable for reversed input and numeric request IDs at equal times', () => {
  const rows = [route(9), route(10, { time: route(9).time, effort: 'max' })];
  assert.equal(latestModeRoute(rows).id, 10);
  assert.equal(latestModeRoute(rows.toReversed()).id, 10);
  assert.equal(latestModeRoute([rows[0], { ...rows[1], session: 'different' }]), null);
});
