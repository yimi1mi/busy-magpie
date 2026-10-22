import {
  connecting,
  empty,
  formatDuration,
  formatEta,
  formatTokens,
  offline,
  present,
} from './presenter.js';
import { modelUsage, paintModelTracks } from './model-usage.mjs';
import { downloadSize } from './download-progress.mjs';
import { acceleratorFromEvent } from './hotkey.mjs';
import { recentRequests, requestActive, requestFailed, attemptRows, redactDiagnostic, errorAdvice, requestSummary, RequestSelection, groupRequests } from './request-model.mjs';

const $ = (id) => document.getElementById(id);

const el = {
  live: $('live'),
  liveState: $('liveState'),
  gateway: $('gateway'),
  appVersion: $('appVersion'),
  stageArea: $('stageArea'),
  stageCanvas: $('stageCanvas'),
  birdSky: $('birdSky'),
  agentNode: $('agentNode'),
  agentGlyph: $('agentGlyph'),
  agentName: $('agentName'),
  agentModel: $('agentModel'),
  agentDot: $('agentDot'),
  hub: $('hub'),
  accountNode: $('accountNode'),
  accountName: $('accountName'),
  accountModel: $('accountModel'),
  accountPlan: $('accountPlan'),
  accountState: $('accountState'),
  accountDot: $('accountDot'),
  accountStateDot: $('accountStateDot'),
  accountToken: $('accountToken'),
  accountQuota: $('accountQuota'),
  accountQuotaBar: $('accountQuotaBar'),
  accountQuotaText: $('accountQuotaText'),
  tokenPill: $('tokenPill'),
  tokenTotal: $('tokenTotal'),
  tokenWindow: $('tokenWindow'),
  tokenMeter: $('tokenMeter'),
  providerIcon: $('providerIcon'),
  wireIn: $('wireIn'),
  wireOut: $('wireOut'),
  caption: $('caption'),
  statRequests: $('statRequests'),
  statRerouted: $('statRerouted'),
  statErrors: $('statErrors'),
  storyTime: $('storyTime'),
  storyRows: [$('storyRow1'), $('storyRow2'), $('storyRow3')],
  stories: [$('story1'), $('story2'), $('story3')],
  lanes: $('lanes'),
  lanesTitle: $('lanesTitle'),
  lanesSub: $('lanesSub'),
  fan: $('fan'),
  fanWires: $('fanWires'),
  fanAgents: $('fanAgents'),
  fanAccounts: $('fanAccounts'),
  fanHub: $('fanHub'),
  fanBirdPath: $('fanBirdPath'),
  multiFooter: $('multiFooter'),
};

let settings = {
  maskAccounts: true,
  gateway: '127.0.0.1:3425',
  usagePeriod: '30d',
  enabledPeriods: ['today', '7d', '30d', 'all'],
  pillMetric: 'total',
  rollTokens: true,
  showQuota: true,
  showTiming: true,
  hubEffect: 'ripple',
};
let lastTrace = null;
let usageData = null;
let usageStatus = { loading: false, stale: false, at: 0, error: '' };
let modelPage = 0;
let historyFilter = 'all';
const requestSelection = new RequestSelection();
let connection = { online: false, detail: '正在连接' };
let layout = false;
let frame = { lanes: 1, cardHeight: 400, windowHeight: 432 };
const seenRoutes = new Set();

const numberAnimations = new WeakMap();
const SVG_NS = 'http://www.w3.org/2000/svg';
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const motionReduced = () => Boolean(settings.quietMotion || reducedMotion.matches);
const flights = new Map();

// The same flying magpie magpie's own Routing page draws: facing right,
// wings beating from the shoulder, banked into the turn.
const FLIER =
  '<g class="rt-lift"><g transform="scale(1.2) translate(-6.5 3.2)">'
  + '<path class="wing far" d="M-14.5 -3.4C-16.5 -9.5 -14.2 -15 -8.6 -18.6C-9.4 -12.6 -9.6 -7.4 -9.2 -3.2Z"/>'
  + '<path class="tail" d="M-31.5 3.1L-18.6 -1.8L-17.4 1.2L-30.8 4.6Z"/>'
  + '<ellipse class="body" cx="-12.2" cy="-1.4" rx="7.6" ry="3.9"/>'
  + '<ellipse class="belly" cx="-12.8" cy="0.4" rx="4.3" ry="1.6"/>'
  + '<circle class="body" cx="-4.9" cy="-3.7" r="3.1"/>'
  + '<path class="body" d="M-2.3 -4.8L1.4 -3.3L-2.3 -2.2Z"/>'
  + '<g class="wing near"><path d="M-15.6 -3.2C-17.8 -10.2 -15.2 -16.4 -8.4 -20.4C-9.3 -13.6 -9.4 -7.8 -8.8 -2.8Z"/>'
  + '<path class="bar" d="M-14.6 -5.6C-15.4 -10.4 -13.8 -14.4 -10.4 -17.2"/></g>'
  + '</g></g>';

function iconSetup() {
  const icons = window.busy.icons || {};
  const bird = $('birdPath');
  const fanBird = $('fanBirdPath');
  const openai = $('openaiPath');
  const deepseek = $('deepseekPath');
  if (icons.magpie) {
    bird.setAttribute('d', icons.magpie);
    fanBird.setAttribute('d', icons.magpie);
  }
  if (icons.openai) openai.setAttribute('d', icons.openai);
  if (icons.deepseek) deepseek.setAttribute('d', icons.deepseek);
}

function applyFrame(next) {
  if (!next || !next.windowHeight) return;
  frame = { ...frame, ...next };
  document.body.classList.toggle('compact', Boolean(frame.compact));
  const root = document.documentElement;
  root.style.setProperty('--window-h', `${frame.windowHeight}px`);
  root.style.setProperty('--card-h', `${frame.cardHeight}px`);
  requestAnimationFrame(() => {
    applyUiScale();
    drawFanWires();
    refreshFlightLegs();
  });
}

// The card is drawn on a fixed canvas and scaled to fit the window, so a
// bigger window means bigger text, nodes and wires rather than empty space.
const CANVAS_W = 600;
const CANVAS_H = 400;

function uiScale() {
  return Number(getComputedStyle(document.documentElement).getPropertyValue('--ui')) || 1;
}

function applyUiScale() {
  const area = el.stageArea?.getBoundingClientRect();
  if (!area || area.width < 40 || area.height < 40) return;
  const scale = Math.max(
    0.5,
    Math.min(2.6, Math.min(area.width / CANVAS_W, area.height / CANVAS_H)),
  );
  document.documentElement.style.setProperty('--ui', scale.toFixed(4));
  requestAnimationFrame(reportHitAreas);
}

function usageTotal(data) {
  if (!data) return 0;
  return (Number(data.input) || 0)
    + (Number(data.output) || 0)
    + (Number(data.cache_read) || 0)
    + (Number(data.cache_write) || 0);
}

// The four windows magpie answers, in the order a click on the pill walks
// them. The short form is what the pill shows; the long one is the tooltip.
const USAGE_PERIODS = ['today', '7d', '30d', 'all'];
const PERIOD_SHORT = { today: '今日', '7d': '7 天', '30d': '30 天', all: '全部' };
const PERIOD_LONG = { today: '今日', '7d': '近 7 天', '30d': '近 30 天', all: '全部' };

// What the pill's rolling number counts: the whole total, or one part of it.
const PILL_METRICS = {
  total: { label: '总 token', pick: usageTotal },
  input: { label: '输入 token', pick: (data) => Number(data.input) || 0 },
  output: { label: '输出 token', pick: (data) => Number(data.output) || 0 },
  cache: { label: '缓存读取', pick: (data) => Number(data.cache_read) || 0 },
};

function pillMetric() {
  return PILL_METRICS[settings.pillMetric] ? settings.pillMetric : 'total';
}

// The windows a click on the pill walks: only the ones switched on, in the
// order today, week, month, all. At least one always survives.
function cyclePeriods() {
  const kept = Array.isArray(settings.enabledPeriods)
    ? settings.enabledPeriods.filter((period) => USAGE_PERIODS.includes(period))
    : [];
  return kept.length ? kept : USAGE_PERIODS.slice();
}

function activePeriod() {
  const fromUsage = String(usageData?.period || '').toLowerCase();
  if (USAGE_PERIODS.includes(fromUsage)) return fromUsage;
  return USAGE_PERIODS.includes(settings.usagePeriod) ? settings.usagePeriod : '30d';
}

function usagePeriod(data) {
  const period = String(data?.period || '');
  const days = /^(\d+)d$/.exec(period);
  if (days) return `近 ${days[1]} 天`;
  if (period === '24h') return '近 24 小时';
  if (period === 'today') return '今日';
  if (period === 'all') return '全部';
  return '总计';
}

function applyUsageTokens() {
  if (usageData) {
    const metricKey = pillMetric();
    const metric = PILL_METRICS[metricKey];
    const value = metric.pick(usageData);
    const input = Number(usageData.input) || 0;
    const output = Number(usageData.output) || 0;
    const cache = Number(usageData.cache_read) || 0;
    const cacheRate = input + cache > 0 ? cache / (input + cache) : null;
    const period = activePeriod();
    applyTokenPill({
      total: value,
      // The bar is the cache hit rate; asking for the cache itself would
      // just repeat the number above it.
      pct: metricKey === 'cache' ? null : cacheRate,
      windowLabel: `${PERIOD_SHORT[period] || ''} · ${{ total: '总量', input: '输入', output: '输出', cache: '缓存' }[metricKey]}`,
      title: `${PERIOD_LONG[period] || usagePeriod(usageData)} · ${metric.label} ${formatTokens(value)}`
        + ` · 输入 ${formatTokens(input)} · 输出 ${formatTokens(output)}`
        + ` · 缓存 ${formatTokens(cache)}${cacheRate !== null ? `（${Math.round(cacheRate * 100)}%）` : ''}`
        + ` · ${Number(usageData.calls || 0).toLocaleString()} 请求`
        + ' · 单击切换时间窗',
    });
    renderModelUsage();
    return;
  }

  // No usage log: fall back to what the trace itself carried.
  const recent = Array.isArray(lastTrace?.routes) ? lastTrace.routes : [];
  const fallback = recent.reduce((sum, route) => (
    sum + (Number(route.tokens) || Number(route.prompt?.tokens) || 0)
  ), 0);
  applyTokenPill({
    total: fallback,
    windowLabel: '近期快照',
    title: `最近 ${recent.length} 个请求合计 ${formatTokens(fallback)}`,
  });
  renderModelUsage();
}

function renderModelUsage() {
  const view = modelUsage(usageData, pillMetric());
  const orbit = $('tokenOrbits');
  const rows = view.consistent ? view.rows : [];
  orbit.toggleAttribute('hidden', !rows.length);
  if (rows.length && el.tokenPill.offsetWidth > 0) paintModelTracks(orbit, rows.slice(0, 3), el.tokenPill.offsetWidth + 18, 45);
  const pages = Math.max(1, Math.ceil(rows.length / 8));
  modelPage = Math.min(modelPage, pages - 1);
  const page = rows.slice(modelPage * 8, modelPage * 8 + 8);
  paintModelTracks($('modelTracks'), page, 360, 146, 6);
  $('modelsTotal').textContent = formatTokens(view.total);
  $('modelsPeriod').textContent = `${PERIOD_SHORT[activePeriod()]} · ${PILL_METRICS[pillMetric()].label}`;
  $('modelsPage').textContent = `${modelPage + 1} / ${pages}`;
  $('modelsPrev').disabled = modelPage === 0;
  $('modelsNext').disabled = modelPage + 1 === pages;
  $('modelsPaging').hidden = pages === 1;
  $('modelsNote').textContent = !view.consistent ? '模型明细与总量不一致，暂不绘制占比。'
    : !rows.length ? '当前网关没有提供该时间窗的模型明细。'
      : `弧长表示模型占当前总量的比例${view.unassigned > 0 ? ` · 未归类 ${formatTokens(view.unassigned)}` : ''}${usageStatus.stale ? ' · 当前为上次成功读取的数据' : ''}`;
  const fragment = document.createDocumentFragment();
  for (const row of page) {
    const item = create('div', 'model-usage-row');
    const dot = create('i', 'model-swatch'); dot.style.background = row.color;
    const name = create('span', 'model-name', row.name); name.title = row.provider ? `${row.name} · ${row.provider}` : row.name;
    item.append(dot, name, create('span', 'mono', formatTokens(row.value)), create('b', 'mono', `${(row.share * 100).toFixed(1)}%`));
    fragment.append(item);
  }
  $('modelsList').replaceChildren(fragment);
}

function renderUsageStatus() {
  const label = $('usageStatus');
  const at = usageStatus.at ? new Date(usageStatus.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
  label.classList.toggle('stale', Boolean(usageStatus.error || usageStatus.stale));
  label.textContent = usageStatus.loading ? `正在读取${PERIOD_SHORT[usageStatus.period] || '用量'}…`
    : usageStatus.error ? (usageStatus.stale ? `暂未刷新 · 上次 ${at || '—'}` : '用量暂不可用')
      : at ? `更新于 ${at}` : '等待用量数据';
  label.title = usageStatus.error || '上方为所选时间窗的用量；下方请求数为网关本次启动以来累计';
  renderModelUsage();
}

function renderRequestHistory() {
  const listTop = $('historyList').scrollTop;
  const detailTop = $('historyDetail').scrollTop;
  const rows = recentRequests(lastTrace, historyFilter, historyFilter === 'active' ? 200 : 20);
  $('historyScope').textContent = historyFilter === 'active' ? '当前活动请求 · 最多 200 条' : '最多 20 条 · 本次网关会话';
  const selected = requestSelection.update(lastTrace);
  $('historyState').textContent = !connection.online ? '网关离线 · 显示上次快照'
    : requestSelection.previousGateway ? '固定的是上次网关会话的请求' : requestSelection.following ? '跟随最新请求' : '已固定查看';
  $('historyFollow').disabled = requestSelection.following;
  const list = document.createDocumentFragment();
  for (const route of rows) {
    const view = present(route, {}, Boolean(settings.maskAccounts));
    const button = create('button', 'history-row'); button.type = 'button';
    button.classList.toggle('selected', String(selected?.id) === String(route.id) && !requestSelection.previousGateway);
    button.dataset.requestId = String(route.id);
    button.append(create('b', '', view.agentName), create('span', '', view.accountModel),
      create('small', requestFailed(route) ? 'error' : '', `${view.timeText} · ${requestActive(route) ? '进行中' : requestFailed(route) ? '失败' : '完成'} · #${route.id}`));
    list.append(button);
  }
  if (!rows.length) list.append(create('p', 'panel-note', '没有符合条件的请求。'));
  $('historyList').replaceChildren(list);
  $('historyList').scrollTop = listTop;
  const detail = $('historyDetail'); detail.replaceChildren();
  $('historyCopy').disabled = !selected;
  if (!selected) { detail.append(create('p', 'panel-note', '请求经过网关后会出现在这里。')); return; }
  const view = present(selected, {}, Boolean(settings.maskAccounts));
  detail.append(create('b', 'request-title', `${view.agentName} · ${view.accountModel}`));
  detail.append(create('p', 'request-state', `${view.accountState} · #${selected.id}`));
  const metrics = create('div', 'request-metrics');
  for (const [label, value] of [['首字', selected.ttft], ['总耗时', selected.ms], ['排队', selected.queued]]) {
    metrics.append(create('span', '', `${label} ${Number(value) > 0 ? formatDuration(value) : '—'}`));
  }
  detail.append(metrics);
  const attempts = attemptRows(selected, Boolean(settings.maskAccounts));
  for (const item of attempts) {
    const row = create('div', `request-attempt${item.failed ? ' failed' : ''}`);
    row.append(create('b', '', `${item.index}. ${item.name} · ${item.state}`),
      create('small', '', `${item.model}${item.status ? ` · HTTP ${item.status}` : ''}${item.ms ? ` · ${formatDuration(item.ms)}` : ''}`));
    if (item.error) row.append(create('pre', 'request-error', item.error));
    detail.append(row);
  }
  if (!attempts.length) detail.append(create('p', 'panel-note', selected.done ? '未记录上游尝试。' : '尚未开始上游尝试。'));
  if (selected.error) detail.append(create('pre', 'request-error', redactDiagnostic(selected.error)));
  if (requestFailed(selected)) detail.append(create('p', 'panel-note', errorAdvice(Number(selected.status))));
  detail.scrollTop = detailTop;
}

let tokenText = '';
const TOKEN_DIGIT_H = 21;

function formatLatency(ms) {
  const value = Number(ms) || 0;
  if (!value) return '—';
  return value < 1000 ? `${Math.round(value)}ms` : `${(value / 1000).toFixed(1)}s`;
}

// What the account card says under its state line: this request's tokens
// and first-byte wait, then how much of the account's allowance is left.
function renderAccountDetail(view) {
  const timing = settings.showTiming !== false ? view.timing : null;
  const parts = [];
  if (view.tokenDetail) parts.push(view.tokenDetail);
  if (timing?.speed) parts.push(`${Math.round(timing.speed.rate)} tok/s`);
  // One row only: with a speed to show, the first-token wait moves to the
  // hover tip instead of pushing the line into an ellipsis.
  if (timing && timing.ttft > 0 && !timing.speed) parts.push(`首字 ${formatLatency(timing.ttft)}`);
  const detail = parts.join(' · ');
  el.accountToken.textContent = detail;
  el.accountToken.hidden = !detail;

  const quota = settings.showQuota !== false ? view.quota : null;
  el.accountQuota.hidden = !quota;
  if (quota) {
    const remaining = Math.max(0, Math.min(100, quota.remaining));
    el.accountQuotaBar.style.width = `${Math.max(1.5, remaining).toFixed(1)}%`;
    el.accountQuota.classList.toggle('low', remaining < 15);
    const eta = formatEta(quota.renewAt);
    el.accountQuotaText.textContent = `额度 ${Math.round(remaining)}%${eta ? ` · ${eta}` : ''}`;
  }

  const tip = [];
  if (quota) {
    const bits = [`剩 ${Math.round(quota.remaining)}%`];
    if (quota.amount && quota.limit) {
      const amount = `${Math.round(quota.amount).toLocaleString()} / ${Math.round(quota.limit).toLocaleString()}`;
      bits.push(`${amount}${quota.unit ? ` ${quota.unit}` : ''}`);
    }
    const eta = formatEta(quota.renewAt);
    if (eta) bits.push(eta);
    tip.push(`额度：${bits.join(' · ')}`);
  }
  if (timing) {
    const bits = [];
    if (timing.speed) {
      bits.push(`${Math.round(timing.speed.rate)} tok/s（${Math.round(timing.speed.tokens).toLocaleString('zh-CN')} token / ${formatDuration(timing.speed.window)}）`);
    }
    if (timing.ttft > 0) bits.push(`首字 ${formatLatency(timing.ttft)}`);
    if (timing.ms > 0) bits.push(`总 ${formatDuration(timing.ms)}`);
    if (timing.queued > 0) bits.push(`排队 ${formatDuration(timing.queued)}`);
    else if (timing.wait > 0) bits.push(`等上游 ${formatDuration(timing.wait)}`);
    if (timing.own > 0) bits.push(`magpie ${formatDuration(timing.own)}`);
    if (bits.length) tip.push(`耗时：${bits.join(' · ')}`);
  }
  el.accountNode.title = tip.join('\n');
}

function staticTokenTrack(char) {
  const track = document.createElement('span');
  track.className = 'token-track';
  const digit = document.createElement('span');
  digit.className = 'token-digit';
  digit.textContent = char;
  track.append(digit);
  return track;
}

function setTokenTotal(text, animate = true) {
  if (!el.tokenTotal || !text) return;
  if (text === tokenText) return;
  const old = tokenText;
  tokenText = text;

  if (!animate) {
    const plain = document.createElement('span');
    plain.className = 'token-plain';
    plain.textContent = text;
    el.tokenTotal.replaceChildren(plain);
    return;
  }

  const roll = document.createElement('span');
  roll.className = 'token-roll';

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const col = document.createElement('span');
    col.className = `token-col${char === '.' ? ' token-col-dot' : ''}`;
    if (!/\d/.test(char)) {
      col.append(staticTokenTrack(char));
      roll.append(col);
      continue;
    }

    const track = document.createElement('span');
    track.className = 'token-track';
    for (let n = 0; n < 20; n++) {
      const digit = document.createElement('span');
      digit.className = 'token-digit';
      digit.textContent = String(n % 10);
      track.append(digit);
    }
    col.append(track);
    roll.append(col);

    if (!old || old.length !== text.length || !/\d/.test(old[i])) {
      track.style.transition = 'none';
      track.style.transform = `translateY(${-Number(char) * TOKEN_DIGIT_H}px)`;
      continue;
    }
    const from = Number(old[i]);
    const to = Number(char);
    if (from === to) {
      track.style.transition = 'none';
      track.style.transform = `translateY(${-to * TOKEN_DIGIT_H}px)`;
      continue;
    }
    // A carry still rolls upward: 9 -> 0 goes through the repeated 0 row.
    const target = to < from ? to + 10 : to;
    track.style.transition = 'none';
    track.style.transform = `translateY(${-from * TOKEN_DIGIT_H}px)`;
    void track.offsetHeight;
    requestAnimationFrame(() => {
      track.style.transition = '';
      track.style.transform = `translateY(${-target * TOKEN_DIGIT_H}px)`;
      window.setTimeout(() => {
        track.style.transition = 'none';
        track.style.transform = `translateY(${-to * TOKEN_DIGIT_H}px)`;
      }, 600);
    });
  }

  el.tokenTotal.replaceChildren(roll);
}

function applyTokenPill({ total = 0, pct = null, title = '', windowLabel = '' } = {}) {
  $('compactTotal').textContent = usageData ? formatTokens(total) : '—';
  $('compactPeriod').textContent = windowLabel;
  $('compactPill').title = title || '单击切换时间窗';
  if (!el.tokenPill) return;
  // A usage summary is shown even at zero, so the pill stays reachable and
  // the next click can walk back out of an empty window.
  if (!total && !usageData) {
    el.tokenPill.hidden = true;
    requestAnimationFrame(reportHitAreas);
    return;
  }
  el.tokenPill.hidden = false;
  const text = formatTokens(total);
  setTokenTotal(text, settings.rollTokens !== false && !motionReduced());
  if (el.tokenWindow) el.tokenWindow.textContent = windowLabel;
  el.tokenPill.title = title || `${text} token`;
  if (el.tokenMeter) {
    el.tokenMeter.parentElement.hidden = pct === null || pct === undefined;
    el.tokenMeter.style.width = pct === null || pct === undefined
      ? '0%'
      : `${Math.max(2, Math.min(100, pct * 100)).toFixed(1)}%`;
  }
  requestAnimationFrame(reportHitAreas);
}

// Main lets the pointer in over controls and the drag strip after scaling.
let lastHitKey = '';

function reportHitAreas() {
  if (!window.busy?.setHitAreas) return;
  const canvas = el.stageCanvas?.getBoundingClientRect();
  if (!canvas) return;
  const scale = uiScale();
  const controls = [el.tokenPill, el.appVersion, $('updateChip'), $('quickMenuToggle'), $('lanesMore'), $('compactPill'), $('compactExpand'), $('compactMenu')]
    .filter((node) => node && !node.hidden && node.isConnected)
    .map((node) => {
      const box = node.getBoundingClientRect();
      return {
        x: Math.round(box.left),
        y: Math.round(box.top),
        width: Math.round(box.width),
        height: Math.round(box.height),
      };
    });
  const payload = {
    controls,
    dragTop: Math.round((frame.compact ? $('compactDragBar') : $('dragBar')).getBoundingClientRect().top),
    dragBottom: Math.round((frame.compact ? $('compactDragBar') : $('dragBar')).getBoundingClientRect().bottom),
    ui: Number(scale.toFixed(4)),
  };
  const key = JSON.stringify(payload);
  if (key === lastHitKey) return;
  lastHitKey = key;
  window.busy.setHitAreas(payload);
}

function setupQuickMenu() {
  const button = $('quickMenuToggle');
  const menu = $('quickMenu');
  const items = [...menu.querySelectorAll('[role="menuitem"]')];
  let open = false;

  button.addEventListener('click', () => window.busy.toggleMenu());
  $('compactMenu').addEventListener('click', () => window.busy.toggleMenu());
  $('compactExpand').addEventListener('click', () => window.busy.toggleCompact());
  menu.addEventListener('click', (event) => {
    const item = event.target.closest('[data-menu-action]');
    if (item) window.busy.menuAction(item.dataset.menuAction);
  });

  const outside = (event) => open && !menu.contains(event.target) && !button.contains(event.target);
  // Consume the entire outside click before restoring native click-through.
  // In particular, pressing the drag bar must only dismiss this menu.
  document.addEventListener('pointerdown', (event) => {
    if (!outside(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  document.addEventListener('click', (event) => {
    if (!outside(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    window.busy.closeMenu();
  }, true);
  window.addEventListener('keydown', (event) => {
    if (!open) return;
    const current = items.indexOf(document.activeElement);
    let next;
    if (event.key === 'ArrowDown') next = (current + 1) % items.length;
    else if (event.key === 'ArrowUp') next = (current + items.length - 1) % items.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    else if (event.key === 'Escape' || event.key === 'Tab') window.busy.closeMenu();
    else return;
    event.preventDefault();
    if (next !== undefined) items[next].focus();
  });

  window.busy.onQuickMenu((value) => {
    open = Boolean(value);
    menu.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    $('compactMenuItem').textContent = settings.compact ? '展开主界面' : '紧凑模式';
    document.body.classList.toggle('menu-open', open);
    $('quickMenuError').hidden = true;
    if (open) items[0].focus({ preventScroll: true });
    else if (menu.contains(document.activeElement)) button.focus({ preventScroll: true });
  });
  window.busy.onActionError((error) => {
    $('quickMenuError').textContent = error;
    $('quickMenuError').hidden = false;
  });
  new ResizeObserver(() => requestAnimationFrame(reportHitAreas)).observe(button.parentElement);
}

function setupTokenPill() {
  const pill = el.tokenPill;
  if (!pill || !window.busy?.setUsagePeriod) return;

  let switching = false;

  const cycle = async () => {
    if (switching || document.body.classList.contains('settings-open')) return;
    const enabled = cyclePeriods();
    const current = activePeriod();
    const next = enabled[(enabled.indexOf(current) + 1) % enabled.length] || enabled[0];
    switching = true;
    pill.classList.add('switching');
    try {
      const result = await window.busy.setUsagePeriod(next);
      if (result?.usage) {
        usageData = result.usage;
        applyUsageTokens();
      }
    } catch {
      // A failed switch leaves the pill on the window it was showing.
    } finally {
      switching = false;
      pill.classList.remove('switching');
    }
  };
  pill.addEventListener('click', cycle);
  $('compactPill').addEventListener('click', cycle);

  new ResizeObserver(() => requestAnimationFrame(reportHitAreas)).observe(pill);
  requestAnimationFrame(reportHitAreas);
}

function create(tag, className, text) {  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setParts(target, parts) {
  target.replaceChildren();
  for (const part of parts || []) {
    const span = document.createElement('span');
    if (part.role && part.role !== 'normal') span.className = part.role;
    span.textContent = part.text;
    target.append(span);
  }
}

// ── magpies that carry a request along the wires ───────────────────────
// Ported from magpie's routing page: a request flies from its agent through
// magpie to the chosen account, then an answer flies back. The bird is
// flipped when travelling left and banked into the curve.

function setupDragBar(bar = $('dragBar')) {
  if (!bar || !window.busy?.dragStart) return;
  let press = null;
  let dragging = false;
  let suppressClick = false;

  const cancelPress = () => {
    if (!press) return;
    clearTimeout(press.timer);
    press = null;
  };

  const finish = (event) => {
    cancelPress();
    if (dragging) {
      dragging = false;
      bar.classList.remove('dragging');
      window.busy.dragEnd();
      window.setTimeout(() => { suppressClick = false; }, 420);
    }
    if (event && bar.hasPointerCapture?.(event.pointerId)) {
      bar.releasePointerCapture(event.pointerId);
    }
  };

  bar.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    try {
      bar.setPointerCapture(event.pointerId);
    } catch {
      // A release that lands outside the window still ends the drag.
    }
    press = {
      x: event.clientX,
      y: event.clientY,
      timer: 0,
    };
    press.timer = window.setTimeout(() => {
      if (!press) return;
      press = null;
      dragging = true;
      suppressClick = true;
      bar.classList.add('dragging');
      window.busy.dragStart();
    }, 150);
  });

  bar.addEventListener('pointermove', (event) => {
    if (!press) return;
    if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > 9) {
      cancelPress();
    }
  });

  bar.addEventListener('pointerup', finish);
  bar.addEventListener('pointercancel', finish);
  window.addEventListener('pointerup', finish, true);
  bar.addEventListener('click', (event) => {
    if (!suppressClick) return;
    event.preventDefault();
    event.stopPropagation();
  }, true);

  window.busy.onGrab?.((value) => {
    document.body.classList.toggle('can-grab', Boolean(value));
  });
}

function setupResizeHandles() {
  const handles = [...document.querySelectorAll('.resize-handle')];
  if (!handles.length || !window.busy?.resizeStart) return;
  let active = null;

  const finish = (event) => {
    if (!active) return;
    const handle = active;
    active = null;
    window.busy.resizeEnd();
    if (event && handle.hasPointerCapture?.(event.pointerId)) {
      handle.releasePointerCapture(event.pointerId);
    }
  };

  for (const handle of handles) {
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      active = handle;
      try {
        handle.setPointerCapture(event.pointerId);
      } catch {
        // Main-process polling still ends the resize if the release is lost.
      }
      window.busy.resizeStart(handle.dataset.resize || 'se');
    });
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
  }

  window.addEventListener('pointerup', finish, true);
  window.busy.onResize?.((value) => {
    document.body.classList.toggle('can-resize', Boolean(value));
  });
}

function setupSettingsPanel() {
  const pane = $('settingsPane');
  if (!pane || !window.busy?.settingsGet) return;
  const form = $('settingsForm');
  const topmost = $('settingsTopmost');
  const mask = $('settingsMask');
  const updateChips = [...document.querySelectorAll('#settingsUpdate .settings-chip')];
  const opacity = $('settingsOpacity');
  const opacityOut = $('settingsOpacityOut');
  const gateway = $('settingsGateway');
  const gatewayHint = $('settingsGatewayHint');
  const periodChips = [...document.querySelectorAll('#settingsPeriods .settings-chip')];
  const metricChips = [...document.querySelectorAll('#settingsMetrics .settings-chip')];
  const effectChips = [...document.querySelectorAll('#settingsEffects .settings-chip')];
  const roll = $('settingsRoll');
  const quota = $('settingsQuota');
  const timing = $('settingsTiming');
  const keepAlive = $('settingsKeepAlive');
  const pathText = $('settingsPath');
  const raw = $('settingsRaw');
  const status = $('settingsStatus');
  const save = $('settingsSave');
  let open = false;
  let busy = false;
  let closeTimer = 0;
  // The opacity on disk, so a drag the user cancels can be put back.
  let savedOpacity = 1;
  let previewingOpacity = false;
  let gatewayReport = '';
  let recordingHotkey = false;
  let recordedHotkey = false;

  const setStatus = (text, error = false) => {
    status.textContent = text || '';
    status.classList.toggle('error', error);
  };

  const pressChips = (chips, active) => {
    for (const chip of chips) {
      const key = chip.dataset.period || chip.dataset.metric
        || chip.dataset.update || chip.dataset.effect;
      chip.setAttribute('aria-pressed', active.has(key) ? 'true' : 'false');
    }
  };

  for (const chip of periodChips) {
    chip.addEventListener('click', () => {
      const on = chip.getAttribute('aria-pressed') === 'true';
      const onCount = periodChips.filter((item) => item.getAttribute('aria-pressed') === 'true').length;
      // One window has to stay on, or the pill has nowhere to roll.
      if (on && onCount <= 1) return;
      chip.setAttribute('aria-pressed', on ? 'false' : 'true');
    });
  }

  for (const chip of metricChips) {
    chip.addEventListener('click', () => {
      for (const other of metricChips) {
        other.setAttribute('aria-pressed', other === chip ? 'true' : 'false');
      }
    });
  }

  for (const chip of updateChips) {
    chip.addEventListener('click', () => {
      for (const other of updateChips) {
        other.setAttribute('aria-pressed', other === chip ? 'true' : 'false');
      }
    });
  }

  for (const chip of effectChips) {
    chip.addEventListener('click', () => {
      for (const other of effectChips) {
        other.setAttribute('aria-pressed', other === chip ? 'true' : 'false');
      }
      // Preview right away: the drawer sits over the card, so the next
      // crossing already uses the new gesture.
      settings = { ...settings, hubEffect: chip.dataset.effect };
    });
  }

  const fill = (data) => {
    const s = data.settings || {};
    topmost.checked = Boolean(s.topmost);
    mask.checked = Boolean(s.maskAccounts);
    pressChips(updateChips, new Set([String(s.updateMode || 'idle')]));
    pressChips(periodChips, new Set(
      Array.isArray(s.enabledPeriods) && s.enabledPeriods.length ? s.enabledPeriods : USAGE_PERIODS,
    ));
    pressChips(metricChips, new Set([String(s.pillMetric || 'total')]));
    pressChips(effectChips, new Set([String(s.hubEffect || 'ripple')]));
    roll.checked = s.rollTokens !== false;
    quota.checked = s.showQuota !== false;
    timing.checked = s.showTiming !== false;
    keepAlive.checked = s.keepAlive !== false;
    $('settingsCompact').checked = Boolean(s.compact);
    $('settingsQuiet').checked = Boolean(s.quietMotion);
    $('settingsHotkeyOn').checked = s.hotkeyOn !== false;
    $('settingsHotkey').value = s.hotkey || 'Control+Alt+M';
    $('hotkeyStatus').textContent = s.hotkeyOn === false ? '快捷键已关闭' : data.hotkey?.ok ? '快捷键已注册' : '快捷键尚未注册成功，可重新录入或关闭';
    opacity.value = String(Math.round((Number(s.opacity) || 1) * 100));
    opacityOut.textContent = `${opacity.value}%`;
    savedOpacity = Math.min(1, Math.max(0.4, Number(s.opacity) || 1));
    previewingOpacity = false;
    gateway.value = s.gateway || '';
    gateway.placeholder = '留空自动检测';
    gatewayHint.textContent = data.gatewayError || `当前 ${data.resolvedGateway || '—'} · ${data.gatewaySource || '自动检测'}`;
    gatewayReport = `Busy Magpie v${data.version}\n网关：${data.resolvedGateway || '未解析'}\n来源：${data.gatewaySource || '自动检测'}\n路由：${connection.online ? '可读取' : connection.detail}\n用量：${usageStatus.error || (usageData ? '可读取' : '尚未读取')}`;
    $('gatewayResult').textContent = '';
    if (pathText) pathText.textContent = data.path || '';
    const openFile = $('settingsOpenFile');
    if (openFile && data.path) openFile.title = data.path;
    if (raw) raw.textContent = data.raw || '';
    if (data.version) $('settingsVersion').textContent = `v${data.version}`;
  };

  const load = async () => {
    try {
      fill(await window.busy.settingsGet());
      setStatus('');
    } catch (error) {
      setStatus(error?.message || '读取设置失败', true);
    }
  };

  const close = () => {
    if (!open) return;
    open = false;
    // A drag that was never saved goes back to what is on disk.
    if (previewingOpacity) window.busy.previewOpacity?.(savedOpacity);
    previewingOpacity = false;
    document.body.classList.add('settings-closing');
    closeTimer = window.setTimeout(() => {
      pane.hidden = true;
      pane.classList.remove('about');
      $('aboutView').hidden = true;
      $('modelsView').hidden = true;
      $('historyView').hidden = true;
      document.body.classList.remove('settings-open', 'settings-closing');
    }, 200);
  };

  const show = (data) => {
    window.clearTimeout(closeTimer);
    open = true;
    document.body.classList.remove('settings-closing');
    pane.hidden = false;
    // Restart the entrance even when it was reopened quickly.
    pane.style.animation = 'none';
    void pane.offsetWidth;
    pane.style.animation = '';
    document.body.classList.add('settings-open');
    const about = data?.mode === 'about';
    const models = data?.mode === 'models';
    const history = data?.mode === 'history';
    pane.dataset.panel = data?.mode || 'settings';
    pane.classList.toggle('about', about);
    $('aboutView').hidden = !about;
    $('modelsView').hidden = !models;
    $('historyView').hidden = !history;
    pane.scrollTop = 0;
    if (about) aboutRefresh?.();
    else if (models) renderModelUsage();
    else if (history) renderRequestHistory();
    else load();
  };

  opacity.addEventListener('input', () => {
    previewingOpacity = true;
    opacityOut.textContent = `${opacity.value}%`;
    window.busy.previewOpacity?.(Number(opacity.value) / 100);
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy) return;
    busy = true;
    save.disabled = true;
    setStatus('保存中…');
    try {
      const result = await window.busy.settingsSave({
        topmost: topmost.checked,
        maskAccounts: mask.checked,
        opacity: Number(opacity.value) / 100,
        updateMode: (updateChips.find((chip) => chip.getAttribute('aria-pressed') === 'true')
          || updateChips[0]).dataset.update,
        gateway: gateway.value.trim(),
        usagePeriod: activePeriod(),
        enabledPeriods: periodChips
          .filter((chip) => chip.getAttribute('aria-pressed') === 'true')
          .map((chip) => chip.dataset.period),
        pillMetric: (metricChips.find((chip) => chip.getAttribute('aria-pressed') === 'true')
          || metricChips[0]).dataset.metric,
        rollTokens: roll.checked,
        showQuota: quota.checked,
        showTiming: timing.checked,
        hubEffect: (effectChips.find((chip) => chip.getAttribute('aria-pressed') === 'true')
          || effectChips[0]).dataset.effect,
        keepAlive: keepAlive.checked,
        compact: $('settingsCompact').checked,
        quietMotion: $('settingsQuiet').checked,
        hotkey: $('settingsHotkey').value,
        hotkeyOn: $('settingsHotkeyOn').checked,
      });
      if (!result?.ok) {
        setStatus(result?.error || '保存失败', true);
        return;
      }
      fill(result);
      setStatus('已保存');
      window.setTimeout(() => window.busy.settingsClose(), 420);
    } catch (error) {
      setStatus(error?.message || '保存失败', true);
    } finally {
      busy = false;
      save.disabled = false;
    }
  });

  $('settingsClose').addEventListener('click', () => window.busy.settingsClose());
  $('settingsCancel').addEventListener('click', () => window.busy.settingsClose());
  $('settingsOpenFile').addEventListener('click', () => window.busy.settingsOpenFile());
  gateway.addEventListener('input', () => { $('gatewayResult').textContent = '当前输入尚未测试'; });
  $('gatewayTest').addEventListener('click', async () => {
    const button = $('gatewayTest'); button.disabled = true;
    $('gatewayResult').textContent = '正在测试路由与用量接口…';
    try {
      const result = await window.busy.testGateway(gateway.value.trim());
      const detail = result.checks.map(check => `${check.name === 'trace' ? '路由' : '用量'}：${check.detail}（${check.ms}ms）`).join('\n');
      gatewayReport = `Busy Magpie ${$('settingsVersion').textContent}\n网关：${result.url || '未解析'}\n来源：${result.source}\n${result.error || detail}`;
      $('gatewayResult').textContent = `${result.ok ? '连接正常' : '连接测试未通过'}\n${result.url || ''}\n${result.error || detail}`;
      $('gatewayResult').classList.toggle('error', !result.ok);
    } catch (error) { $('gatewayResult').textContent = error.message || '测试失败'; }
    finally { button.disabled = false; }
  });
  $('gatewayCopy').addEventListener('click', async () => {
    try {
      const copied = await window.busy.copySummary(redactDiagnostic(gatewayReport, 5000));
      $('gatewayResult').textContent = copied ? '已复制诊断信息，不含账号和凭据。' : '复制失败';
    } catch { $('gatewayResult').textContent = '复制失败'; }
  });
  $('hotkeyRecord').addEventListener('click', () => window.busy.captureHotkey(!recordingHotkey));
  $('settingsResetPosition').addEventListener('click', async () => {
    const result = await window.busy.resetPlacement();
    setStatus(result.ok ? '已恢复默认位置和大小' : result.error, !result.ok);
  });
  window.busy.onHotkeyCapture((on) => {
    recordingHotkey = Boolean(on);
    $('hotkeyRecord').textContent = on ? '取消录制' : '录制快捷键';
    if (on) { recordedHotkey = false; $('hotkeyStatus').textContent = '请按组合键，例如 Ctrl+Alt+M；Esc 取消'; $('settingsHotkey').focus(); }
    else if (!recordedHotkey) $('hotkeyStatus').textContent = '已取消录制';
  });
  $('settingsHotkey').addEventListener('keydown', async (event) => {
    if (!recordingHotkey) return;
    event.preventDefault(); event.stopPropagation();
    if (event.key === 'Escape') { window.busy.captureHotkey(false); return; }
    const value = acceleratorFromEvent(event, window.busy.platform);
    if (!value) return;
    recordedHotkey = true;
    $('settingsHotkey').value = value;
    window.busy.captureHotkey(false);
    try {
      const result = await window.busy.testHotkey(value);
      $('hotkeyStatus').textContent = result.ok ? '组合键可用，保存后生效' : result.error;
    } catch { $('hotkeyStatus').textContent = '无法检测快捷键，请重试'; }
  });
  $('modelsClose').addEventListener('click', () => window.busy.settingsClose());
  $('modelsPrev').addEventListener('click', () => { modelPage = Math.max(0, modelPage - 1); renderModelUsage(); });
  $('modelsNext').addEventListener('click', () => { modelPage++; renderModelUsage(); });
  $('historyClose').addEventListener('click', () => window.busy.settingsClose());
  $('historyFilter').addEventListener('change', (event) => { historyFilter = event.target.value; $('historyList').scrollTop = 0; renderRequestHistory(); });
  $('historyFollow').addEventListener('click', () => { requestSelection.follow(lastTrace); renderRequestHistory(); });
  $('historyList').addEventListener('click', (event) => {
    const button = event.target.closest('[data-request-id]');
    if (!button) return;
    const route = (lastTrace?.routes || []).find(row => String(row.id) === button.dataset.requestId);
    if (route) { requestSelection.select(route, lastTrace); $('historyDetail').scrollTop = 0; renderRequestHistory(); }
  });
  $('historyCopy').addEventListener('click', async () => {
    const route = requestSelection.snapshot;
    if (!route) return;
    const view = present(route, {}, true);
    try {
      const copied = await window.busy.copySummary(requestSummary(route, view.agentName));
      $('historyCopyStatus').textContent = copied ? '已复制脱敏摘要' : '摘要过长，未复制';
    } catch { $('historyCopyStatus').textContent = '复制失败'; }
  });

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      window.busy.settingsClose();
    }
  });

  window.busy.onSettingsPanel((data) => {
    if (data?.open) show(data);
    else close();
  });
}

let aboutRefresh = null;
let renderUpdateState = null;

function setupAbout() {
  const view = $('aboutView');
  if (!view) return;

  const button = el.appVersion;
  const dot = $('updateDot');
  const chip = $('updateChip');
  const chipVersion = $('updateChipVersion');
  const current = $('aboutCurrent');
  const latest = $('aboutLatest');
  const arrow = $('aboutArrow');
  const status = $('aboutStatus');
  const progress = $('updateProgress');
  const progressBar = $('updateProgressBar');
  const update = $('aboutUpdate');
  const check = $('aboutCheck');
  const skip = $('aboutSkip');
  const release = $('aboutRelease');
  const error = $('aboutError');

  const render = (data) => {
    if (!data) return;
    const available = Boolean(data.available && !data.skipped);
    const pct = Math.round((Number(data.progress) || 0) * 100);
    const showLatest = Boolean(data.latest && (available || data.skipped || data.error));
    // electron-updater downloads first and installs on the way out, so a
    // ready update is a restart, not another download.
    const ready = Boolean(data.ready && available);
    dot.hidden = !available;
    // The card's own one-click path: it only says which version and how far
    // along the download is, and quits into the installer on its own.
    const running = Boolean(data.downloading || data.installing);
    const size = downloadSize(data.downloadedBytes, data.totalBytes);
    document.body.classList.toggle('updating', running);
    if (chip) {
      chip.hidden = !available && !running;
      if (!chip.hidden) {
        chipVersion.textContent = data.installing
          ? '安装中'
          : data.downloading ? size.compact : ready ? '' : `v${data.latest || ''}`;
        chip.firstChild.textContent = data.downloading ? '下载 ' : ready ? '重启更新' : '更新 ';
        chip.title = data.downloading ? `${size.text} · ${pct}%` : '';
        chip.disabled = running;
      }
      // The two share one spot: a pending release takes the version's place,
      // so the header never reads both. The tray has 关于 in the meantime.
      if (button) button.hidden = !chip.hidden;
    }
    current.textContent = `v${data.current || data.version || '—'}`;
    latest.textContent = showLatest ? `v${data.latest}` : '';
    latest.hidden = !showLatest;
    arrow.hidden = !showLatest;
    $('aboutPlugin').textContent = data.pluginVersion ? `v${data.pluginVersion}` : '未提供';

    update.hidden = !available || data.downloading || data.installing;
    update.textContent = ready ? '重启并安装' : `更新到 v${data.latest || ''}`;
    skip.hidden = !available || data.downloading || data.installing;
    check.disabled = Boolean(data.checking || data.downloading || data.installing);
    release.hidden = !data.releaseUrl || (!available && !data.error && !data.skipped);

    progress.hidden = !(data.downloading || data.installing);
    progressBar.style.width = `${data.installing ? 100 : pct}%`;
    $('updateBytes').textContent = size.text;
    $('updatePercent').textContent = `${pct}%`;
    $('updateProgressMeta').hidden = !(data.downloading || data.installing || data.ready);

    if (data.error) {
      status.textContent = data.error;
      error.textContent = '可打开 GitHub Releases 手动安装。';
    } else if (data.downloading) {
      status.textContent = `正在下载 v${data.latest} · ${pct}%`;
      error.textContent = '';
    } else if (data.installing) {
      status.textContent = '正在安装，应用会重启…';
      error.textContent = '';
    } else if (data.ready && available) {
      status.textContent = `已下载 v${data.latest}，点「重启并安装」完成`;
      error.textContent = '';
    } else if (data.checking) {
      status.textContent = '正在检查更新…';
      error.textContent = '';
    } else if (available) {
      status.textContent = `发现新版本 v${data.latest}`;
      error.textContent = '';
    } else if (data.skipped) {
      status.textContent = `已跳过 v${data.latest}，可在发布页手动安装。`;
      error.textContent = '';
    } else if (data.latest) {
      status.textContent = '已是最新版本。';
      error.textContent = '';
    } else {
      status.textContent = '还没有检查更新。';
      error.textContent = '';
    }
  };

  renderUpdateState = render;

  aboutRefresh = async () => {
    try {
      render(await window.busy.updatesGet());
    } catch (err) {
      status.textContent = err?.message || '读取版本信息失败';
    }
  };

  // The header is where people ask "is there a newer one?": open 关于 and ask
  // straight away, instead of making them find 检查更新 in the panel.
  button?.addEventListener('click', () => {
    window.busy.aboutOpen();
    window.busy.updatesCheck();
  });
  chip?.addEventListener('click', () => {
    if (!chip.disabled) window.busy.updatesInstall();
  });
  $('aboutClose').addEventListener('click', () => window.busy.settingsClose());
  check.addEventListener('click', () => window.busy.updatesCheck());
  update.addEventListener('click', () => {
    if (window.confirm('更新会重启 Busy Magpie，是否继续？')) {
      window.busy.updatesInstall();
    }
  });
  skip.addEventListener('click', () => window.busy.updatesSkip());
  release.addEventListener('click', () => window.busy.updateOpenRelease());

  window.busy.onUpdateState((data) => render(data));

  window.busy.onAbout(() => {
    const pane = $('settingsPane');
    pane.classList.add('about');
    view.hidden = false;
    aboutRefresh?.();
  });
}

function setupFirstRun() {
  const mask = $('firstRunMask');
  if (!mask) return;

  const show = () => {
    mask.hidden = false;
    requestAnimationFrame(() => $('firstRunDismiss')?.focus());
  };

  const hide = () => {
    mask.hidden = true;
  };

  $('firstRunDismiss')?.addEventListener('click', () => {
    window.busy.firstRunDismiss();
    hide();
  });
  $('firstRunOpenDir')?.addEventListener('click', () => {
    window.busy.openInstallDir();
  });

  window.busy.onFirstRun?.((open) => {
    if (open) show();
    else hide();
  });

  firstRunShow = show;
}

let firstRunShow = null;

function stopFlights() {
  for (const flight of flights.values()) {
    flight.active = false;
    flight.bird.remove();
    flight.guides.remove();
    flight.fx.remove();
  }
  flights.clear();
}

// A resize moves every anchor, so the flights already in the air have to be
// told where the wires are now.
function refreshFlightLegs() {
  for (const flight of flights.values()) {
    if (flight.active) buildFlightLegs(flight);
  }
}

function syncFlights(routes, multi) {  if (motionReduced()) {
    stopFlights();
    return;
  }

  const wanted = new Map();
  if (multi) {
    for (const route of routes) wanted.set(String(route.id), route);
  } else if (routes.length === 1) {
    wanted.set('single', routes[0]);
  }

  for (const [key, flight] of [...flights]) {
    if (wanted.has(key)) continue;
    // The route finished, not the layout: let the bird land where it is
    // going, then go. Removing it on the spot made the answer look like it
    // vanished halfway through the return.
    if (flight.single === !multi) {
      flight.finishing = true;
      continue;
    }
    flight.active = false;
    flight.bird.remove();
    flight.guides.remove();
    flight.fx.remove();
    flights.delete(key);
  }

  for (const [key, route] of wanted) {
    const color = agentColor(route.agent);
    const existing = flights.get(key);
    if (existing) {
      if (existing.color !== color) {
        existing.color = color;
        existing.bird.style.setProperty('--agent', color);
      }
      continue;
    }
    startFlight(key, route, multi, color);
  }
}

function startFlight(key, route, multi, color) {
  const bird = document.createElementNS(SVG_NS, 'g');
  bird.setAttribute('class', 'flying-bird');
  bird.style.setProperty('--agent', color);
  bird.style.opacity = '0';
  // The flier and the packet are separate on purpose: magpie's own routing
  // page drops the bird at the account and leaves the request's dot waiting
  // there, so the wait belongs to the dot, not to the courier.
  const flier = document.createElementNS(SVG_NS, 'g');
  flier.setAttribute('class', 'flier');
  flier.innerHTML = FLIER;
  const packet = document.createElementNS(SVG_NS, 'circle');
  packet.setAttribute('class', 'packet');
  packet.setAttribute('r', '3.2');
  packet.setAttribute('cx', '0');
  packet.setAttribute('cy', '0');
  bird.append(flier, packet);

  const guides = document.createElementNS(SVG_NS, 'g');
  guides.setAttribute('aria-hidden', 'true');
  // One-shot sparks and shockwaves from a hub pass live here, under the bird.
  const fx = document.createElementNS(SVG_NS, 'g');
  fx.setAttribute('aria-hidden', 'true');
  el.birdSky.append(guides, fx, bird);

  const flight = {
    key,
    routeId: String(route.id),
    single: !multi,
    color,
    bird,
    flier,
    guides,
    fx,
    hubCenter: null,
    hubHalf: null,
    // A crossing effect may squeeze or dissolve the bird for a moment.
    fxScale: 1,
    fxAlpha: 1,
    // Where the last frame left the bird, and the clock that drives its drift.
    pose: null,
    born: performance.now(),
    wobPhase: Math.random() * Math.PI * 2,
    pace: 1,
    // The bank angle eases towards the path's tangent, the way it does on
    // magpie's own stage, instead of snapping on every corner.
    aim: null,
    aimFlip: false,
    active: true,
    leg1: null,
    leg2: null,
    phase: 160 + Math.random() * 900,
    rest: 820 + Math.random() * 500,
    legPause: 110 + Math.random() * 90,
  };
  flights.set(key, flight);
  runFlight(flight);
}

function buildFlightLegs(flight) {
  let agent;
  let account;
  if (flight.single) {
    agent = el.agentNode;
    account = el.accountNode;
  } else {
    const id = CSS.escape(flight.routeId);
    agent = el.fanAgents.querySelector(`[data-id="${id}"]`);
    account = el.fanAccounts.querySelector(`[data-id="${id}"]`);
  }
  const hub = flight.single
    ? document.querySelector('#hub .hub-card')
    : el.fanHub.querySelector('.hub-card');
  if (!agent || !account || !hub || !agent.isConnected || !account.isConnected) return false;

  const sky = el.birdSky.getBoundingClientRect();
  const ar = agent.getBoundingClientRect();
  const cr = account.getBoundingClientRect();
  const hr = hub.getBoundingClientRect();
  // getBoundingClientRect is in the scaled, screen-space pixels, while the
  // sky's own coordinate system is the unscaled 600×400 canvas, so the
  // offsets have to be divided back into it or the flight drifts sideways
  // as soon as the card is scaled.
  const s = uiScale();
  const ax = (ar.right - sky.left) / s;
  const ay = (ar.top - sky.top + ar.height / 2) / s;
  const cx = (cr.left - sky.left) / s;
  const cy = (cr.top - sky.top + cr.height / 2) / s;
  const hl = (hr.left - sky.left) / s;
  const hrx = (hr.right - sky.left) / s;
  const hy = (hr.top - sky.top + hr.height / 2) / s;

  // Both ends of the trip stop on the edge of their card, never inside it:
  // the bird has to be visible when it arrives, and it is only parked there
  // for a beat before it fades (see perch()).
  //
  // Every rebuild re-rolls the control points, so no two trips trace the same
  // curve: the bird may climb, dip, or hop over magpie depending on the roll.
  // The endpoints stay pinned to the cards, or it would miss them.
  const wander = (amount) => (Math.random() - 0.5) * amount;
  // The hop over magpie stays shallow: a tall arc over a 44px card reads as a
  // jump, not as passing through.
  const bow = 7 + Math.random() * 4;
  const climb1 = wander(28);
  const climb2 = wander(20);
  const climb3 = wander(26);
  const climb4 = wander(18);
  const d1 = `M ${ax} ${ay} C ${(ax + (hl - ax) * 0.45).toFixed(1)} ${(ay + climb1).toFixed(1)}, ${(hl - (hl - ax) * 0.35).toFixed(1)} ${(hy + climb2).toFixed(1)}, ${hl} ${hy}`;
  // through magpie, not teleporting from its left edge to its right
  const dHub = `M ${hl} ${hy} C ${(hl + (hrx - hl) * 0.32).toFixed(1)} ${(hy - bow).toFixed(1)}, ${(hrx - (hrx - hl) * 0.32).toFixed(1)} ${(hy - bow * (0.7 + Math.random() * 0.6)).toFixed(1)}, ${hrx} ${hy}`;
  const d2 = `M ${hrx} ${hy} C ${(hrx + (cx - hrx) * 0.35).toFixed(1)} ${(hy + climb3).toFixed(1)}, ${(cx - (cx - hrx) * 0.45).toFixed(1)} ${(cy + climb4).toFixed(1)}, ${cx} ${cy}`;

  // A slight change of pace per trip, so the loop never feels metronomic.
  flight.pace = 0.8 + Math.random() * 0.45;

  const leg1 = document.createElementNS(SVG_NS, 'path');
  const legHub = document.createElementNS(SVG_NS, 'path');
  const leg2 = document.createElementNS(SVG_NS, 'path');
  const legAll = document.createElementNS(SVG_NS, 'path');
  leg1.setAttribute('d', d1);
  legHub.setAttribute('d', dHub);
  leg2.setAttribute('d', d2);
  legAll.setAttribute('d', `${d1} ${dHub} ${d2}`);
  for (const path of [leg1, legHub, leg2, legAll]) {
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'none');
  }
  flight.guides.replaceChildren(leg1, legHub, leg2, legAll);
  flight.leg1 = leg1;
  flight.legHub = legHub;
  flight.leg2 = leg2;
  flight.legAll = legAll;
  // The bird flies the three legs as one path. Animating each leg with its own
  // ease-in-out made it stop dead at every boundary, which read as a hop.
  const l1 = leg1.getTotalLength();
  const lHub = legHub.getTotalLength();
  flight.hubMid = l1 + lHub * 0.45;
  // Where the request crosses magpie, in the sky's own coordinates: passHub
  // puts its ring and sparks here.
  flight.hubCenter = { x: (hl + hrx) / 2, y: hy };
  flight.hubHalf = { x: (hrx - hl) / 2, y: hr.height / s / 2 };
  return true;
}

// fade: the bird dissolves where it meets the agent or the account instead of
// popping in and out. Only the start of a trip needs it now; perch() fades the
// arrival.
const FADE_SHARE = 0.12;

function smoothstep(t) {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}

// The distance v. time curve for one trip: soft ends, and a slow zone over
// magpie so the crossing effect gets read. It is one continuous curve, so the
// bird loses speed at the hub without ever stopping dead (which used to read
// as a hop).
const TRIP_SAMPLES = 180;
const tripProfile = (() => {
  const cum = [0];
  let prev = 0;
  for (let i = 1; i <= TRIP_SAMPLES; i += 1) {
    const u = i / TRIP_SAMPLES;
    let speed = Math.sin(Math.PI * u) ** 0.85;
    const d = Math.abs(u - 0.5) / 0.17;
    if (d < 1) speed *= 1 - 0.55 * (0.5 + 0.5 * Math.cos(Math.PI * d));
    cum.push(cum[i - 1] + (speed + prev) / 2);
    prev = speed;
  }
  const total = cum[TRIP_SAMPLES] || 1;
  return cum.map((value) => value / total);
})();

function tripProgress(raw) {
  const at = Math.min(TRIP_SAMPLES, Math.max(0, raw * TRIP_SAMPLES));
  const i0 = Math.floor(at);
  const rest = at - i0;
  const a = tripProfile[i0];
  const b = tripProfile[Math.min(TRIP_SAMPLES, i0 + 1)];
  return a + (b - a) * rest;
}

function flyTrip(flight, reverse) {
  const path = flight.legAll;
  const len = path.getTotalLength();
  return new Promise((resolve) => {
    if (!len) {
      resolve();
      return;
    }
    // One continuous profile across agent → magpie → account, so the bird
    // carries speed through the hub instead of stopping at its edges.
    const duration = Math.max(1200, Math.min(2600, len * 6)) * (flight.pace || 1);
    const t0 = performance.now();
    let fired = false;
    const step = (now) => {
      if (!flight.active) {
        resolve();
        return;
      }
      const raw = Math.max(0, Math.min(1, (now - t0) / duration));
      const progress = tripProgress(raw);
      const distance = reverse ? len * (1 - progress) : len * progress;
      // The hub answers when the bird reaches it, whichever way it is going.
      if (!fired) {
        const reached = reverse ? distance <= flight.hubMid : distance >= flight.hubMid;
        if (reached) {
          fired = true;
          passHub(flight, reverse);
        }
      }
      const p0 = path.getPointAtLength(Math.max(0, distance - 2));
      const p1 = path.getPointAtLength(Math.min(len, distance + 2));
      const p = path.getPointAtLength(distance);
      // p0→p1 points forward along the wire; a return flight travels the
      // other way, so its heading (and bank) is the opposite vector.
      let vx = p1.x - p0.x;
      let vy = p1.y - p0.y;
      if (reverse) {
        vx = -vx;
        vy = -vy;
      }
      if (Math.abs(vx) + Math.abs(vy) < 0.01) vx = reverse ? -1 : 1;
      const aim = Math.max(-24, Math.min(24, Math.atan2(vy, Math.abs(vx)) * 180 / Math.PI));
      const flip = vx < 0 ? -1 : 1;
      // Ease towards the tangent instead of snapping to it: turning round at
      // the account would otherwise whip the bird through 180° in one frame.
      if (flight.aim === null || flight.aimFlip !== (vx < 0)) {
        flight.aim = aim;
        flight.aimFlip = vx < 0;
      } else {
        flight.aim += (aim - flight.aim) * 0.12;
      }
      const bank = flight.aim;
      const scale = 0.68 * (flight.fxScale || 1);
      // A wing-beat of lateral drift on top of the curve: without it the bird
      // slides along a rail, with it the flight looks steered.
      const speed = Math.hypot(vx, vy) || 1;
      const phase = ((now - flight.born) / 380) * Math.PI * 2 + flight.wobPhase;
      const drift = Math.sin(phase) * 2.6;
      const roll = Math.cos(phase) * 6;
      const px = p.x - (vy / speed) * drift;
      const py = p.y + (vx / speed) * drift;
      flight.pose = { x: px, y: py, flip, scale, bank };
      flight.bird.setAttribute(
        'transform',
        `translate(${px.toFixed(1)} ${py.toFixed(1)}) scale(${(flip * scale).toFixed(3)} ${scale.toFixed(3)}) rotate(${(bank + roll).toFixed(1)})`,
      );
      // A trip fades in where it starts; the reply starts from a dot that is
      // already visible, so it does not blink out and back in.
      const alpha = reverse ? 1 : smoothstep(raw / FADE_SHARE);
      flight.bird.style.opacity = (alpha * (flight.fxAlpha ?? 1)).toFixed(3);
      if (raw < 1) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
}

// Arriving is part of the trip: the bird reaches the account, sits there for a
// beat, and then lets go — the request's dot stays at the account while the
// answer is on its way, which is exactly what magpie's own stage does with it.
const PERCH_MS = 160;
const PERCH_FADE_MS = 200;

function arrive(flight) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const hold = (now) => {
      if (!flight.active) {
        resolve();
        return;
      }
      flight.bird.style.opacity = '1';
      // A short settle where it landed: the bird dips and comes to rest
      // instead of freezing the instant the path ends.
      const pose = flight.pose;
      const dt = now - t0;
      if (pose) {
        const bob = Math.sin(dt / 130) * 1.6 * Math.exp(-dt / 320);
        flight.bird.setAttribute(
          'transform',
          `translate(${pose.x.toFixed(1)} ${(pose.y + bob).toFixed(1)}) scale(${(pose.flip * pose.scale).toFixed(3)} ${pose.scale.toFixed(3)}) rotate(${pose.bank.toFixed(1)})`,
        );
      }
      if (dt < PERCH_MS) {
        requestAnimationFrame(hold);
        return;
      }
      // The courier dissolves; the dot it was carrying stays behind, held.
      flight.flier.style.opacity = '0';
      flight.bird.classList.add('held');
      window.setTimeout(resolve, PERCH_FADE_MS);
    };
    requestAnimationFrame(hold);
  });
}

// The answer is ready: a bird takes the dot back on.
function depart(flight) {
  flight.bird.classList.remove('held');
  flight.flier.style.opacity = '1';
}

// The dot waits at the account for as long as the answer takes, which is what
// magpie's own stage does with it. A floor keeps a very fast answer readable
// and a cap keeps a stale trace from parking a dot there forever.
const ANSWER_MIN_MS = 650;
const ANSWER_MAX_MS = 8000;

function waitForAnswer(flight) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const check = () => {
      const waited = performance.now() - t0;
      if (!flight.active || waited >= ANSWER_MAX_MS
        || (flight.finishing && waited >= ANSWER_MIN_MS)) {
        resolve();
        return;
      }
      window.setTimeout(check, 120);
    };
    check();
  });
}

// The reply has landed; nothing of the flight stays.
function land(flight) {
  return new Promise((resolve) => {
    flight.bird.style.transition = `opacity ${PERCH_FADE_MS}ms ease-out`;
    requestAnimationFrame(() => { flight.bird.style.opacity = '0'; });
    window.setTimeout(() => {
      flight.bird.style.transition = '';
      resolve();
    }, PERCH_FADE_MS + 20);
  });
}

async function runFlight(flight) {
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  await pause(flight.phase);
  while (flight.active) {
    if (!buildFlightLegs(flight)) {
      await pause(400);
      continue;
    }

    flight.bird.classList.remove('back');
    await flyTrip(flight, false);
    if (!flight.active) break;
    await arrive(flight);
    if (!flight.active) break;
    // A route that finished while its answer was owed still gets its reply
    // flown home; only the idle wait between rounds is skipped.
    if (flight.finishing) {
      depart(flight);
      await flyTrip(flight, true);
      if (!flight.active) break;
      await land(flight);
      break;
    }
    await waitForAnswer(flight);

    flight.bird.classList.add('back');
    depart(flight);
    await flyTrip(flight, true);
    if (!flight.active) break;
    await land(flight);
    if (!flight.active || flight.finishing) break;
    await pause(flight.rest);
  }
  flight.bird.remove();
  flight.guides.remove();
  flight.fx.remove();
  flights.delete(flight.key);
}

// ── the hub a request flies through ────────────────────────────────────
// Crossing magpie is the one moment every route shares, so it gets a
// flourish. Four gestures are staged behind 设置 → 穿过动效; each is one-shot
// and removes itself, so a transparent always-on window pays nothing once the
// pass is over.
const HUB_EFFECTS = ['none', 'ripple', 'vortex', 'dissolve', 'arc'];
const HUB_FLASH_MS = 460;
const HUB_BURSTS = 3;
const hubPassTimers = new WeakMap();
const hubBursts = new WeakMap();

function passHub(flight, back = false) {
  if (!flight.active) return;
  // 设置 → 穿过动效 → 无: the crossing stays silent, and the bird just flies.
  if (settings.hubEffect === 'none') return;
  const hub = flight.single ? el.hub : el.fanHub;
  if (!hub || !hub.querySelector('.hub-card')) return;

  // Shared opening: the card takes the agent's colour and the logo gives a
  // small start, whichever gesture follows.
  hub.style.setProperty('--route', flight.color);
  hub.classList.remove('passing');
  // Reading a layout property drops the previous animation, so two passes in
  // quick succession each get a full gesture instead of sharing one.
  void hub.offsetWidth;
  hub.classList.add('passing');
  clearTimeout(hubPassTimers.get(hub));
  hubPassTimers.set(hub, window.setTimeout(
    () => hub.classList.remove('passing'),
    HUB_FLASH_MS,
  ));

  flight.bird.classList.add('passing');
  window.setTimeout(() => flight.bird.classList.remove('passing'), 640);

  const center = flight.hubCenter;
  if (!center || !flight.fx) return;
  const burst = hubBurst(hub, flight.fx);
  const effect = HUB_EFFECTS.includes(settings.hubEffect) ? settings.hubEffect : 'ripple';
  if (effect === 'vortex') vortexPass(burst, flight, center);
  else if (effect === 'dissolve') dissolvePass(burst, flight, center);
  else if (effect === 'arc') arcPass(burst, flight, center);
  else ripplePass(burst, flight, center, back);
}

function hubBurst(hub, fx) {
  const burst = document.createElementNS(SVG_NS, 'g');
  burst.setAttribute('aria-hidden', 'true');
  fx.append(burst);
  // With several requests in the air the bursts would pile into a smear, so
  // only the last few are kept: the hub still looks busy, but a crossing can
  // still be read as one crossing.
  let live = hubBursts.get(hub);
  if (!live) {
    live = [];
    hubBursts.set(hub, live);
  }
  live.push(burst);
  while (live.length > HUB_BURSTS) live.shift().remove();
  window.setTimeout(() => {
    burst.remove();
    const at = live.indexOf(burst);
    if (at >= 0) live.splice(at, 1);
  }, 1000);
  return burst;
}

function skyCircle(burst, center, r, paint = {}) {
  const dot = document.createElementNS(SVG_NS, 'circle');
  dot.setAttribute('cx', String(center.x));
  dot.setAttribute('cy', String(center.y));
  dot.setAttribute('r', String(r));
  for (const [key, value] of Object.entries(paint)) dot.setAttribute(key, value);
  // Scale must be measured from each shape's own box, or the dot would slide
  // towards the sky's top-left corner as it shrinks.
  dot.style.transformBox = 'fill-box';
  dot.style.transformOrigin = 'center';
  burst.append(dot);
  return dot;
}

function tweenFlight(flight, ms, fn) {
  const t0 = performance.now();
  const step = (now) => {
    if (!flight.active) return;
    const t = Math.min(1, (now - t0) / ms);
    fn(t);
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/* 01 ─ a ring and a few sparks ─────────────────────────────────────────── */
function ripplePass(burst, flight, center, back) {
  skyCircle(burst, center, 9, { class: 'hub-shock', fill: 'none', stroke: flight.color });
  // The answer is a quieter visitor than the request that went out.
  const count = back ? 5 : 8;
  for (let i = 0; i < count; i++) {
    const spark = skyCircle(burst, center, (1 + Math.random() * 0.9).toFixed(2), {
      class: 'hub-spark',
      fill: flight.color,
    });
    const angle = (Math.PI * 2 * i) / count + Math.random() * 0.7;
    const distance = 16 + Math.random() * 20;
    spark.style.setProperty('--dx', `${(Math.cos(angle) * distance).toFixed(1)}px`);
    spark.style.setProperty('--dy', `${(Math.sin(angle) * distance).toFixed(1)}px`);
  }
}

/* 02 ─ the bird is pulled in, then spat out ────────────────────────────── */
function vortexPass(burst, flight, center) {
  const swirl = skyCircle(burst, center, 13, {
    class: 'hub-swirl',
    fill: 'none',
    stroke: flight.color,
    'stroke-width': '1.1',
    'stroke-dasharray': '5 5',
    'stroke-linecap': 'round',
  });
  swirl.animate([
    { transform: 'scale(1.6) rotate(0deg)', opacity: 0 },
    { transform: 'scale(1) rotate(200deg)', opacity: 0.9, offset: 0.55 },
    { transform: 'scale(0.3) rotate(430deg)', opacity: 0 },
  ], { duration: 620, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' });

  for (let i = 0; i < 10; i++) {
    const dot = skyCircle(burst, center, 1.2, { class: 'hub-orbit', fill: i % 2 ? flight.color : '#ffffff' });
    const a0 = (Math.PI * 2 * i) / 10;
    const a1 = a0 + Math.PI * 0.9;
    dot.animate([
      {
        transform: `translate(${(Math.cos(a0) * 46).toFixed(1)}px, ${(Math.sin(a0) * 46).toFixed(1)}px) scale(1)`,
        opacity: 0,
      },
      {
        transform: `translate(${(Math.cos(a1) * 22).toFixed(1)}px, ${(Math.sin(a1) * 22).toFixed(1)}px) scale(0.9)`,
        opacity: 0.95,
        offset: 0.45,
      },
      { transform: 'translate(0px, 0px) scale(0.1)', opacity: 0 },
    ], { duration: 620, delay: i * 12, easing: 'cubic-bezier(.5,0,.3,1)', fill: 'forwards' });
  }

  // the bird is squeezed into a point while it is inside the door
  tweenFlight(flight, 520, (t) => {
    flight.fxScale = 1 - Math.sin(Math.PI * t) * 0.7;
    if (t === 1) flight.fxScale = 1;
  });
}

/* 03 ─ the bird comes apart and re-forms ───────────────────────────────── */
function dissolvePass(burst, flight, center) {
  for (let i = 0; i < 16; i++) {
    const dot = skyCircle(burst, center, (0.9 + Math.random() * 0.9).toFixed(2), {
      class: 'hub-dust',
      fill: i % 3 === 0 ? '#ffffff' : flight.color,
    });
    const a = Math.random() * Math.PI * 2;
    const d = 8 + Math.random() * 26;
    dot.animate([
      { transform: 'translate(0px, 0px) scale(1)', opacity: 1 },
      {
        transform: `translate(${(Math.cos(a) * d).toFixed(1)}px, ${(Math.sin(a) * d).toFixed(1)}px) scale(0.3)`,
        opacity: 0,
      },
    ], {
      duration: 420 + Math.random() * 220,
      delay: Math.random() * 70,
      easing: 'cubic-bezier(.2,.7,.4,1)',
      fill: 'forwards',
    });
  }

  // the bird becomes the dust while it is inside the card, then re-forms
  tweenFlight(flight, 90, (t) => { flight.fxAlpha = 1 - t; });
  window.setTimeout(() => {
    if (!flight.active) return;
    tweenFlight(flight, 170, (t) => { flight.fxAlpha = t; });
  }, 190);
}

/* 04 ─ a few arcs across the card ──────────────────────────────────────── */
function arcPass(burst, flight, center) {
  const half = flight.hubHalf || { x: 22, y: 22 };
  for (let i = 0; i < 3; i++) {
    const points = [];
    let x = center.x - half.x;
    let y = center.y - half.y * 0.9;
    points.push(`M ${x.toFixed(1)} ${y.toFixed(1)}`);
    while (x < center.x + half.x) {
      x += 3 + Math.random() * 4;
      y += (Math.random() - 0.5) * 10;
      y = Math.max(center.y - half.y, Math.min(center.y + half.y, y));
      points.push(`L ${Math.min(center.x + half.x, x).toFixed(1)} ${y.toFixed(1)}`);
    }
    const bolt = document.createElementNS(SVG_NS, 'path');
    bolt.setAttribute('class', 'hub-bolt');
    bolt.setAttribute('d', points.join(' '));
    bolt.setAttribute('fill', 'none');
    bolt.setAttribute('stroke', i === 1 ? '#ffffff' : flight.color);
    bolt.setAttribute('stroke-width', (0.8 + Math.random()).toFixed(2));
    bolt.setAttribute('stroke-linejoin', 'round');
    bolt.setAttribute('stroke-linecap', 'round');
    burst.append(bolt);
    bolt.animate([
      { opacity: 0 },
      { opacity: 1, offset: 0.16 },
      { opacity: 0.15, offset: 0.48 },
      { opacity: 1, offset: 0.64 },
      { opacity: 0 },
    ], { duration: 300 + i * 80, easing: 'steps(1, end)', fill: 'forwards' });
  }
}

function agentMark(agent, glyph) {
  if (String(agent || '').toLowerCase() === 'dsh') {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', '#deepseekMark');
    svg.append(use);
    return svg;
  }
  return document.createTextNode(glyph || '');
}

function cubeMark() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M12 3 20 7.5v9L12 21 4 16.5v-9L12 3Z M4 7.5l8 4.5 8-4.5 M12 12v9');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.4');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

function providerMark(icon) {
  if (icon && /openai/i.test(icon)) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', '#openaiMark');
    svg.append(use);
    return svg;
  }
  if (icon && /codex/i.test(icon)) {
    return create('span', 'generic mono', '>_');
  }
  if (icon && /anthropic/i.test(icon)) {
    return create('span', 'generic', 'A');
  }
  return cubeMark();
}

function setStatusDot(node, kind) {
  node.className = `status-dot ${kind}`;
}

function stateClass(view) {
  return view.failed ? 'failed' : view.inFlight ? 'inflight' : view.hasRoute ? 'done' : 'idle';
}

function stateDot(kind) {
  return kind === 'failed' ? 'bad' : kind === 'done' ? 'good' : kind === 'inflight' ? 'accent' : 'warn';
}

function animateNumber(target, value) {
  if (motionReduced()) {
    const animation = numberAnimations.get(target);
    if (animation) cancelAnimationFrame(animation);
    target.textContent = Number(value).toLocaleString('zh-CN');
    target.dataset.rendered = String(value);
    return;
  }
  const next = Math.max(0, Number(value) || 0);
  if (target.dataset.value === String(next)) return;
  target.dataset.value = String(next);
  const previous = Number(target.dataset.rendered || 0);
  if (previous === next) {
    target.textContent = next.toLocaleString('zh-CN');
    return;
  }

  const start = performance.now();
  const duration = 460;
  const oldAnimation = numberAnimations.get(target);
  if (oldAnimation) cancelAnimationFrame(oldAnimation);

  const tick = (now) => {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    const current = Math.round(previous + (next - previous) * eased);
    target.textContent = current.toLocaleString('zh-CN');
    target.dataset.rendered = String(current);
    if (t < 1) numberAnimations.set(target, requestAnimationFrame(tick));
    else {
      target.dataset.rendered = String(next);
      target.textContent = next.toLocaleString('zh-CN');
    }
  };
  numberAnimations.set(target, requestAnimationFrame(tick));
}

function setLiveChrome(view) {
  const waiting = !connection.detail || connection.detail === '正在连接' || connection.detail === '正在重新连接';
  // A card that lost the gateway retries on its own; saying so keeps it from
  // looking like a dead end that needs 重新连接 in the tray.
  const retrying = !connection.online && Boolean(connection.retry);
  const state = connection.online ? 'real' : waiting || retrying ? 'connecting' : 'offline';
  el.live.classList.toggle('active', Boolean(connection.online && view?.inFlight));
  el.live.classList.toggle('connecting', state === 'connecting');
  el.live.classList.toggle('offline', state === 'offline');

  if (state === 'real') {
    el.liveState.textContent = '实时';
  } else if (state === 'connecting') {
    el.liveState.textContent = retrying ? '重连中' : '连接中';
  } else {
    el.liveState.textContent = '未连接';
  }
}

function applyGateway() {
  // The card's header names magpie, not its port: the address lives in the
  // settings panel and in the about pane, where it is asked for.
  if (el.gateway) el.gateway.textContent = settings.gateway || '127.0.0.1:3425';
}

function setMulti(on) {
  const current = document.body.classList.contains('multi');
  if (current === on) return;
  document.body.classList.toggle('multi', on);
  if (!on) {
    el.fanAgents.replaceChildren();
    el.fanAccounts.replaceChildren();
    el.fanWires.replaceChildren();
    seenRoutes.clear();
  }
}

function renderView(view, color = '#a18bff') {
  setMulti(false);
  setLiveChrome(view);
  el.agentNode.style.setProperty('--route', color);
  el.wireIn.style.setProperty('--route', color);
  el.wireOut.style.setProperty('--route', color);

  el.agentName.textContent = view.agentName;
  el.agentGlyph.replaceChildren(agentMark(view.agentId, view.agentGlyph));
  el.agentModel.textContent = view.agentModel;
  el.agentNode.style.opacity = view.hasRoute ? '1' : '0.72';
  setStatusDot(el.agentDot, view.failed ? 'bad' : view.hasRoute ? 'good' : 'warn');

  el.accountName.textContent = view.accountName;
  el.accountName.title = view.accountName;
  el.accountModel.textContent = view.accountModel;
  el.accountPlan.textContent = view.accountPlan || '';
  el.accountPlan.hidden = !view.accountPlan;
  el.accountState.textContent = view.accountState;
  renderAccountDetail(view);
  applyUsageTokens();
  el.providerIcon.replaceChildren(providerMark(view.providerIcon));

  const kind = stateClass(view);
  el.accountNode.dataset.state = kind;
  el.accountNode.classList.toggle('inflight', kind === 'inflight');
  el.accountNode.classList.toggle('done', kind === 'done');
  el.accountNode.classList.toggle('failed', kind === 'failed');
  const dot = stateDot(kind);
  setStatusDot(el.accountDot, 'account');
  setStatusDot(el.accountStateDot, dot);

  setParts(el.caption, view.caption);

  const wireState = view.failed ? 'failed' : view.inFlight ? 'active' : view.hasRoute ? 'done' : '';
  for (const wire of [el.wireIn, el.wireOut]) {
    wire.classList.toggle('active', wireState === 'active');
    wire.classList.toggle('done', wireState === 'done');
    wire.classList.toggle('failed', wireState === 'failed');
  }
  el.hub.classList.toggle('active', Boolean(view.inFlight));
  el.accountNode.style.opacity = view.hasRoute ? '1' : '0.72';

  renderStory(view);
  animateNumber(el.statRequests, view.requests);
  animateNumber(el.statRerouted, view.rerouted);
  animateNumber(el.statErrors, view.errors);
}

// Each agent wears its own mark's colour. Codex, Cursor and Grok are monochrome
// brands, so their black/white is lifted just enough to sit on a near-black
// card; DeepSeek, Claude and Gemini keep their brand hue with more light.
const ROUTE_COLORS = {
  codex: '#EFEDF7',
  dsh: '#7C93FF',
  claude: '#EC9B7C',
  'claude-code': '#EC9B7C',
  cursor: '#9A97AD',
  gemini: '#7FA9FF',
  opencode: '#8EDCB9',
  qoder: '#F2A98B',
  grok: '#E6E4EE',
  zcode: '#9BC7FF',
};

const FALLBACK_COLORS = ['#A18BFF', '#61D7E7', '#DDA2FF', '#8EB6FF', '#F1C66B', '#8EDCB9', '#FFA7B8'];

function agentColor(agent) {
  const id = String(agent || '').toLowerCase();
  if (ROUTE_COLORS[id]) return ROUTE_COLORS[id];
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) % 9973;
  return FALLBACK_COLORS[hash % FALLBACK_COLORS.length];
}



function renderMulti(routes, totals) {
  setMulti(true);
  setLiveChrome({ inFlight: true });

  const groups = groupRequests(routes);
  const visible = groups.slice(0, 4);
  const ordered = visible.map(group => group.route);
  const count = visible.length;
  // The card and the lower half are fixed. The fan gets 134px, so more
  // agents means shorter rows, not a taller window.
  const available = 134;
  const gap = count <= 2 ? 8 : count === 3 ? 3 : 2;
  const maxNode = count === 1 ? 80 : count === 2 ? 65 : count === 3 ? 44 : 33;
  const nodeHeight = Math.max(
    18,
    Math.min(maxNode, Math.floor((available - gap * (count - 1)) / count)),
  );
  el.fan.style.setProperty('--fan-node-h', `${nodeHeight}px`);
  el.fan.style.setProperty('--fan-gap', `${gap}px`);
  el.fan.classList.toggle('dense', count >= 3);
  el.fan.classList.toggle('tight', count >= 2);
  el.fan.classList.toggle('crowded', count >= 3);
  el.fan.classList.toggle('ultra', count >= 4);
  el.fan.classList.toggle('micro', count >= 5);

  el.lanesTitle.textContent = `${routes.length} 个请求正在执行`;
  el.lanesSub.textContent = `${groups.length} 组 · 按 Agent / 会话`;
  $('lanesMore').hidden = groups.length <= 4 && routes.length === groups.length;
  $('lanesMore').textContent = groups.length > 4 ? `另有 ${groups.length - 4} 组` : `展开 ${routes.length} 个请求`;
  renderStory(present(chooseLatest(routes), totals, Boolean(settings.maskAccounts)));

  setParts(el.caption, [
    { text: `${routes.length} 个请求 · ${groups.length} 组活动`, role: 'strong' },
    { text: ' · 按 Agent / 会话合并显示。', role: 'muted' },
  ]);

  const ids = new Set(ordered.map((route) => String(route.id)));
  for (const id of [...seenRoutes]) {
    if (!ids.has(id)) seenRoutes.delete(id);
  }

  const agentFragment = document.createDocumentFragment();
  const accountFragment = document.createDocumentFragment();
  for (const group of visible) {
    const route = group.route;
    const id = String(route.id);
    const fresh = !seenRoutes.has(id);
    if (fresh) seenRoutes.add(id);
    const view = present(route, totals, Boolean(settings.maskAccounts));
    view.agentName += group.routes.length > 1 ? ` · ${group.routes.length}` : '';
    view.agentModel = group.context;
    const color = agentColor(route.agent);
    agentFragment.append(buildFanAgent(route, view, fresh, color));
  }
  // The account column has its own order, as it does in magpie: a request
  // does not sit level with its account, so the wires cross through the hub.
  const accountOrder = visible.slice().sort((a, b) => accountCompare(a.route, b.route));
  for (const group of accountOrder) {
    const route = group.route;
    const id = String(route.id);
    const fresh = !seenRoutes.has(id);
    const view = present(route, totals, Boolean(settings.maskAccounts));
    if (group.routes.length > 1) {
      view.accountName = group.accountCount > 1 ? `${group.accountCount} 个账号`
        : group.accountCount === 0 ? '等待账号' : view.accountName;
      view.accountState = `${group.routes.length} 个请求${group.pendingAccounts ? ` · ${group.pendingAccounts} 待选` : '进行中'}`;
      if (group.modelCount > 1) view.accountModel = `${group.modelCount} 个模型`;
    }
    const color = agentColor(route.agent);
    accountFragment.append(buildFanAccount(route, view, fresh, color));
  }
  el.fanAgents.replaceChildren(agentFragment);
  el.fanAccounts.replaceChildren(accountFragment);

  animateNumber(el.statRequests, Number(totals?.requests) || 0);
  animateNumber(el.statRerouted, Number(totals?.rerouted) || 0);
  animateNumber(el.statErrors, Number(totals?.errors) || 0);

  applyUsageTokens();
  el.accountToken.hidden = true;

  syncFlights(ordered, true);
  requestAnimationFrame(() => {
    drawFanWires();
    reportHitAreas();
    setTimeout(drawFanWires, 80);
  });
}

function buildFanAgent(route, view, fresh, color) {
  const agent = create('section', `node agent${fresh ? ' fresh' : ''}`);
  agent.dataset.id = String(route.id);
  agent.style.setProperty('--route', color);
  const icon = create('div', 'agent-icon');
  icon.append(agentMark(view.agentId, view.agentGlyph));
  agent.append(icon);

  const copy = create('div', 'agent-copy');
  const line = create('div', 'agent-line');
  line.append(create('i', 'status-dot'));
  line.append(create('b', '', view.agentName));
  copy.append(line, create('div', 'mono model', view.agentModel));
  agent.append(copy);
  return agent;
}

function buildFanAccount(route, view, fresh, color) {
  const kind = stateClass(view);
  const account = create('section', `node account${fresh ? ' fresh' : ''}`);
  account.dataset.id = String(route.id);
  account.dataset.state = kind;
  account.style.setProperty('--route', color);
  if (kind === 'failed') account.classList.add('failed');
  else if (kind === 'inflight') account.classList.add('inflight');
  else account.classList.add('done');

  const top = create('div', 'account-top');
  const accountDot = create('i');
  setStatusDot(accountDot, 'account');
  const icon = create('span', 'provider-icon');
  icon.append(providerMark(view.providerIcon));
  top.append(accountDot, icon, create('b', 'account-name', view.accountName));

  const mid = create('div', 'account-mid');
  mid.append(create('span', 'mono model-chip', view.accountModel));
  const plan = create('span', 'plan', view.accountPlan || '');
  plan.hidden = !view.accountPlan;
  mid.append(plan);

  const state = create('div', 'account-state');
  const stateDotEl = create('i');
  setStatusDot(stateDotEl, stateDotClass(kind));
  state.append(stateDotEl, create('span', '', view.accountState));

  account.append(top, mid, state);
  return account;
}

function drawFanWires() {
  if (!document.body.classList.contains('multi')) return;
  const fan = el.fan.getBoundingClientRect();
  if (fan.width < 10 || fan.height < 10) return;

  const hubCard = el.fanHub.querySelector('.hub-card')?.getBoundingClientRect();
  if (!hubCard) return;

  const agents = [...el.fanAgents.children];
  const accounts = [...el.fanAccounts.children];
  if (!agents.length || !accounts.length) return;

  el.fanWires.setAttribute('viewBox', `0 0 ${fan.width} ${fan.height}`);
  el.fanWires.setAttribute('width', String(fan.width));
  el.fanWires.setAttribute('height', String(fan.height));

  const hubLeft = hubCard.left - fan.left;
  const hubRight = hubCard.right - fan.left;
  const hubY = hubCard.top - fan.top + hubCard.height / 2;
  const fragment = document.createDocumentFragment();

  // Stable per-request phases survive redraws and changes in lane order.
  const flowCycle = 1800;
  const now = performance.now();
  const wire = (d, color, fresh, endX, endY, key, outgoing) => {
    let seed = 0;
    for (const char of String(key)) seed = (seed * 31 + char.charCodeAt(0)) >>> 0;
    const phase = -((now + seed % flowCycle + (outgoing ? 600 : 0)) % flowCycle) / 1000;
    const link = document.createElementNS(SVG_NS, 'g');
    link.setAttribute('class', `fan-link${fresh ? ' fresh' : ''}`);
    link.dataset.route = key;
    link.dataset.side = outgoing ? 'out' : 'in';
    link.style.setProperty('--route', color);
    link.style.setProperty('--flow', `${phase.toFixed(3)}s`);

    for (const className of ['fan-wire-under', 'fan-wire-track', 'fan-wire-trail', 'fan-wire-path']) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('class', className);
      path.setAttribute('d', d);
      path.setAttribute('pathLength', '100');
      link.append(path);
    }

    const port = document.createElementNS(SVG_NS, 'circle');
    port.setAttribute('class', 'fan-wire-port');
    port.setAttribute('cx', String(endX));
    port.setAttribute('cy', String(endY));
    port.setAttribute('r', '3.2');
    link.append(port);

    const end = document.createElementNS(SVG_NS, 'circle');
    end.setAttribute('class', 'fan-wire-end');
    end.setAttribute('cx', String(endX));
    end.setAttribute('cy', String(endY));
    end.setAttribute('r', '1.3');
    link.append(end);
    fragment.append(link);
  };

  // Every source joins the same point on magpie; every account leaves the
  // same point on the other side. Accounts keep their own column order, so
  // a wire can cross another on its way through the hub.
  for (const agent of agents) {
    const rect = agent.getBoundingClientRect();
    const color = agent.style.getPropertyValue('--route') || '#A18BFF';
    const fresh = agent.classList.contains('fresh');
    const ax = rect.right - fan.left;
    const ay = rect.top - fan.top + rect.height / 2;
    const d = `M ${ax} ${ay} C ${ax + (hubLeft - ax) * 0.45} ${ay}, ${hubLeft - (hubLeft - ax) * 0.35} ${hubY}, ${hubLeft} ${hubY}`;
    wire(d, color, fresh, ax, ay, agent.dataset.id, false);
  }

  for (const account of accounts) {
    const rect = account.getBoundingClientRect();
    const color = account.style.getPropertyValue('--route') || '#A18BFF';
    const fresh = account.classList.contains('fresh');
    const cx = rect.left - fan.left;
    const cy = rect.top - fan.top + rect.height / 2;
    const d = `M ${hubRight} ${hubY} C ${hubRight + (cx - hubRight) * 0.35} ${hubY}, ${cx - (cx - hubRight) * 0.45} ${cy}, ${cx} ${cy}`;
    wire(d, color, fresh, cx, cy, account.dataset.id, true);
  }

  el.fanWires.replaceChildren(fragment);
}

function stateDotClass(kind) {
  return kind === 'failed' ? 'bad' : kind === 'done' ? 'good' : 'accent';
}

function renderStory(view) {
  const lines = view.story || [];
  if (lines.length === 0) {
    setParts(el.stories[0], [{ text: '还没有请求经过 magpie。', role: 'muted' }]);
    setParts(el.stories[1], [{ text: '从任意 Agent 发一条消息，这里会实时展开。', role: 'muted' }]);
    el.storyRows[0].hidden = false;
    el.storyRows[1].hidden = false;
    el.storyRows[2].hidden = true;
    el.storyTime.textContent = '';
    el.storyTime.hidden = true;
    return;
  }

  for (let i = 0; i < 3; i++) {
    const row = el.storyRows[i];
    const line = lines[i];
    row.hidden = !line;
    row.classList.remove('pulse', 'failed', 'done');
    if (!line) continue;
    if (i === 2) {
      if (line.bullet === 'pulse') row.classList.add('pulse');
      if (line.bullet === 'failed') row.classList.add('failed');
      if (line.bullet === 'done') row.classList.add('done');
    }
    setParts(el.stories[i], line.parts);
  }

  el.storyTime.textContent = view.timeText || '';
  el.storyTime.hidden = !view.timeText;
}

function render() {
  const activeCount = (lastTrace?.routes || []).filter(isInFlight).length;
  $('compactStatus').textContent = connection.online ? activeCount ? `${activeCount} 个请求进行中` : '已连接 · 空闲' : connection.retry ? '自动重连中' : '未连接';
  $('compactLiveDot').classList.toggle('online', Boolean(connection.online));
  if (!$('historyView').hidden) renderRequestHistory();
  if (!connection.online) {
    const waiting = !connection.detail || connection.detail === '正在连接' || connection.detail === '正在重新连接';
    stopFlights();
    renderView(waiting
      ? connecting(lastTrace?.totals)
      : offline(connection.detail, settings.gateway, lastTrace?.totals));
    return;
  }

  if (!lastTrace) {
    stopFlights();
    renderView(empty(undefined));
    return;
  }

  const routes = Array.isArray(lastTrace.routes) ? lastTrace.routes : [];
  const active = routes.filter(isInFlight);
  if (active.length >= 2) {
    renderMulti(active, lastTrace.totals);
    return;
  }

  const route = active[0] || chooseLatest(routes);
  renderView(
    present(route, lastTrace.totals, Boolean(settings.maskAccounts)),
    route ? agentColor(route.agent) : '#a18bff',
  );
  syncFlights(active, false);
}

function isInFlight(route) {
  return requestActive(route);
}

function stamp(route) {
  const time = new Date(route.time).getTime();
  return Number.isFinite(time) ? time : 0;
}

function accountCompare(a, b) {
  const provider = (route) => String(route.provider || '').toLowerCase();
  const account = (route) => {
    const tries = Array.isArray(route.tries) ? route.tries : [];
    const last = tries[tries.length - 1];
    return String(route.served || route.account || last?.who || '').toLowerCase();
  };
  const byProvider = provider(b).localeCompare(provider(a));
  if (byProvider !== 0) return byProvider;
  return account(a).localeCompare(account(b));
}

function chooseLatest(routes) {
  return routes.slice().sort((a, b) => stamp(b) - stamp(a))[0] || null;
}

function setLayout(on) {
  layout = Boolean(on);
  document.body.classList.toggle('layout', layout);
  if (layout) document.activeElement?.blur();
}

function applySettings(next) {
  settings = { ...settings, ...(next || {}) };
  document.body.classList.toggle('noanim', Boolean(settings.quietMotion));
  applyGateway();
  render();
}

async function boot() {
  iconSetup();
  applyGateway();

  const data = await window.busy.bootstrap();
  if (data.version) $('appVersionText').textContent = `v${data.version}`;
  if (data.settings) settings = { ...settings, ...data.settings };
  document.body.classList.toggle('noanim', Boolean(settings.quietMotion));
  if (data.connection) connection = data.connection;
  if (data.trace) lastTrace = data.trace;
  if (data.usage) usageData = data.usage;
  if (data.usageStatus) usageStatus = data.usageStatus;
  applyFrame(data.frame);
  applyGateway();
  setLayout(data.layout);
  render();
  renderUsageStatus();

  window.busy.onTrace((trace) => {
    lastTrace = trace;
    connection = { online: true, detail: settings.gateway };
    render();
  });

  window.busy.onConnection((status) => {
    connection = status || { online: false, detail: '读取失败' };
    render();
  });

  window.busy.onSettings((next) => applySettings(next));
  window.busy.onLayout((on) => setLayout(on));
  window.busy.onFrame((next) => applyFrame(next));
  window.busy.onUsage((next) => {
    usageData = next;
    applyUsageTokens();
  });
  window.busy.onUsageStatus((next) => {
    usageStatus = next;
    renderUsageStatus();
  });

  new ResizeObserver(() => requestAnimationFrame(drawFanWires)).observe(el.fan);
  new ResizeObserver(() => requestAnimationFrame(applyUiScale)).observe(el.stageArea);
  applyUiScale();

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && layout) window.busy.endLayout();
  });

  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('drop', (event) => event.preventDefault());
  window.addEventListener('beforeunload', stopFlights);
  reducedMotion.addEventListener('change', render);
  setupDragBar();
  setupDragBar($('compactDragBar'));
  setupResizeHandles();
  setupSettingsPanel();
  setupAbout();
  setupFirstRun();
  setupTokenPill();
  setupQuickMenu();
  $('lanesMore').addEventListener('click', () => {
    historyFilter = 'active';
    $('historyFilter').value = 'active';
    window.busy.openHistory();
  });
  window.busy.ready?.();
  if (data.update) renderUpdateState?.(data.update);
  if (data.firstRun) firstRunShow?.();
}

boot().catch((error) => {
  connection = { online: false, detail: error?.message || '界面加载失败' };
  render();
});
