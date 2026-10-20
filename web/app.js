import {
  connecting,
  empty,
  formatTokens,
  offline,
  present,
} from './presenter.js';

const $ = (id) => document.getElementById(id);

const el = {
  live: $('live'),
  liveState: $('liveState'),
  gateway: $('gateway'),
  appVersion: $('appVersion'),
  hubPort: $('hubPort'),
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
  tokenPill: $('tokenPill'),
  tokenTotal: $('tokenTotal'),
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
  fanHubPort: $('fanHubPort'),
  fanBirdPath: $('fanBirdPath'),
  multiFooter: $('multiFooter'),
};

let settings = { maskAccounts: true, gateway: '127.0.0.1:3425' };
let lastTrace = null;
let usageData = null;
let connection = { online: false, detail: '正在连接' };
let layout = false;
let frame = { lanes: 1, cardHeight: 400, windowHeight: 432 };
const seenRoutes = new Set();

const numberAnimations = new WeakMap();
const SVG_NS = 'http://www.w3.org/2000/svg';
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
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
  const root = document.documentElement;
  root.style.setProperty('--window-h', `${frame.windowHeight}px`);
  root.style.setProperty('--card-h', `${frame.cardHeight}px`);
  requestAnimationFrame(drawFanWires);
}

function usageTotal(data) {
  if (!data) return 0;
  return (Number(data.input) || 0)
    + (Number(data.output) || 0)
    + (Number(data.cache_read) || 0)
    + (Number(data.cache_write) || 0);
}

function usagePeriod(data) {
  const period = String(data?.period || '');
  const days = /^(\d+)d$/.exec(period);
  if (days) return `近 ${days[1]} 天`;
  if (period === '24h') return '近 24 小时';
  return '总计';
}

function applyUsageTokens() {
  const total = usageTotal(usageData);
  if (total > 0) {
    const input = Number(usageData.input) || 0;
    const output = Number(usageData.output) || 0;
    const cache = Number(usageData.cache_read) || 0;
    const cacheRate = input + cache > 0 ? cache / (input + cache) : null;
    applyTokenPill({
      label: '总',
      total,
      pct: cacheRate,
      title: `${usagePeriod(usageData)} · 输入 ${formatTokens(input)} · 输出 ${formatTokens(output)}`
        + ` · 缓存 ${formatTokens(cache)}${cacheRate !== null ? `（${Math.round(cacheRate * 100)}%）` : ''}`
        + ` · ${Number(usageData.calls || 0).toLocaleString()} 请求`,
    });
    return;
  }

  const recent = Array.isArray(lastTrace?.routes) ? lastTrace.routes : [];
  const fallback = recent.reduce((sum, route) => (
    sum + (Number(route.tokens) || Number(route.prompt?.tokens) || 0)
  ), 0);
  applyTokenPill({
    label: '总',
    total: fallback,
    title: `最近 ${recent.length} 个请求合计 ${formatTokens(fallback)}`,
  });
}

let tokenText = '';
const TOKEN_DIGIT_H = 21;

function staticTokenTrack(char) {
  const track = document.createElement('span');
  track.className = 'token-track';
  const digit = document.createElement('span');
  digit.className = 'token-digit';
  digit.textContent = char;
  track.append(digit);
  return track;
}

function setTokenTotal(text) {
  if (!el.tokenTotal || !text) return;
  if (text === tokenText) return;
  const old = tokenText;
  tokenText = text;
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

function applyTokenPill({ total = 0, pct = null, title = '', label = '本次' } = {}) {
  if (!el.tokenPill) return;
  if (!total) {
    el.tokenPill.hidden = true;
    return;
  }
  el.tokenPill.hidden = false;
  const text = formatTokens(total);
  setTokenTotal(text);
  el.tokenPill.title = title || `${label} ${text}`;
  if (el.tokenMeter) {
    el.tokenMeter.parentElement.hidden = pct === null || pct === undefined;
    el.tokenMeter.style.width = pct === null || pct === undefined
      ? '0%'
      : `${Math.max(2, Math.min(100, pct * 100)).toFixed(1)}%`;
  }
}

function create(tag, className, text) {
  const node = document.createElement(tag);
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

function setupDragBar() {
  const bar = $('dragBar');
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
    }, 360);
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
  const opacity = $('settingsOpacity');
  const opacityOut = $('settingsOpacityOut');
  const gateway = $('settingsGateway');
  const gatewayHint = $('settingsGatewayHint');
  const pathText = $('settingsPath');
  const raw = $('settingsRaw');
  const status = $('settingsStatus');
  const save = $('settingsSave');
  let open = false;
  let busy = false;
  let closeTimer = 0;

  const setStatus = (text, error = false) => {
    status.textContent = text || '';
    status.classList.toggle('error', error);
  };

  const fill = (data) => {
    const s = data.settings || {};
    topmost.checked = Boolean(s.topmost);
    mask.checked = Boolean(s.maskAccounts);
    opacity.value = String(Math.round((Number(s.opacity) || 1) * 100));
    opacityOut.textContent = `${opacity.value}%`;
    gateway.value = s.gateway || '';
    gateway.placeholder = `留空自动检测（当前 ${data.resolvedGateway || '127.0.0.1:3425'}）`;
    gatewayHint.textContent = `当前连接：${data.resolvedGateway || '127.0.0.1:3425'}`;
    pathText.textContent = data.path || '';
    raw.textContent = data.raw || '';
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
    document.body.classList.add('settings-closing');
    closeTimer = window.setTimeout(() => {
      pane.hidden = true;
      document.body.classList.remove('settings-open', 'settings-closing');
      document.documentElement.style.removeProperty('--base-content-h');
    }, 260);
  };

  const show = (data) => {
    window.clearTimeout(closeTimer);
    open = true;
    document.documentElement.style.setProperty('--base-content-h', `${Math.max(120, data.baseCardHeight || 368)}px`);
    document.body.classList.remove('settings-closing');
    pane.hidden = false;
    // Restart the drawer entrance even when it was reopened quickly.
    pane.style.animation = 'none';
    void pane.offsetWidth;
    pane.style.animation = '';
    document.body.classList.add('settings-open');
    pane.scrollTop = 0;
    load();
  };

  opacity.addEventListener('input', () => {
    opacityOut.textContent = `${opacity.value}%`;
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
        gateway: gateway.value.trim(),
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

function stopFlights() {
  for (const flight of flights.values()) {
    flight.active = false;
    flight.bird.remove();
    flight.guides.remove();
  }
  flights.clear();
}

function syncFlights(routes, multi) {
  if (reducedMotion.matches) {
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
    if (!wanted.has(key)) {
      flight.active = false;
      flight.bird.remove();
      flight.guides.remove();
      flights.delete(key);
    }
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
  bird.innerHTML = FLIER;
  const packet = document.createElementNS(SVG_NS, 'circle');
  packet.setAttribute('class', 'packet');
  packet.setAttribute('r', '3.2');
  packet.setAttribute('cx', '0');
  packet.setAttribute('cy', '0');
  bird.append(packet);

  const guides = document.createElementNS(SVG_NS, 'g');
  guides.setAttribute('aria-hidden', 'true');
  el.birdSky.append(guides, bird);

  const flight = {
    key,
    routeId: String(route.id),
    single: !multi,
    color,
    bird,
    guides,
    active: true,
    leg1: null,
    leg2: null,
    phase: 160 + Math.random() * 900,
    answerHold: 480 + Math.random() * 300,
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
  const ax = ar.right - sky.left;
  const ay = ar.top - sky.top + ar.height / 2;
  const cx = cr.left - sky.left;
  const cy = cr.top - sky.top + cr.height / 2;
  const hl = hr.left - sky.left;
  const hrx = hr.right - sky.left;
  const hy = hr.top - sky.top + hr.height / 2;

  const d1 = `M ${ax} ${ay} C ${ax + (hl - ax) * 0.45} ${ay}, ${hl - (hl - ax) * 0.35} ${hy}, ${hl} ${hy}`;
  // through magpie, not teleporting from its left edge to its right
  const dHub = `M ${hl} ${hy} C ${hl + (hrx - hl) * 0.32} ${hy - 11}, ${hrx - (hrx - hl) * 0.32} ${hy - 11}, ${hrx} ${hy}`;
  const d2 = `M ${hrx} ${hy} C ${hrx + (cx - hrx) * 0.35} ${hy}, ${cx - (cx - hrx) * 0.45} ${cy}, ${cx} ${cy}`;

  const leg1 = document.createElementNS(SVG_NS, 'path');
  const legHub = document.createElementNS(SVG_NS, 'path');
  const leg2 = document.createElementNS(SVG_NS, 'path');
  leg1.setAttribute('d', d1);
  legHub.setAttribute('d', dHub);
  leg2.setAttribute('d', d2);
  for (const path of [leg1, legHub, leg2]) {
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'none');
  }
  flight.guides.replaceChildren(leg1, legHub, leg2);
  flight.leg1 = leg1;
  flight.legHub = legHub;
  flight.leg2 = leg2;
  return true;
}

function flyLeg(flight, path, reverse) {
  return new Promise((resolve) => {
    const len = path.getTotalLength();
    if (!len) {
      resolve();
      return;
    }
    const duration = Math.max(430, Math.min(1100, len * 8));
    const t0 = performance.now();
    const step = (now) => {
      if (!flight.active) {
        resolve();
        return;
      }
      const raw = Math.min(1, (now - t0) / duration);
      const eased = (1 - Math.cos(Math.PI * raw)) / 2;
      const distance = reverse ? len * (1 - eased) : len * eased;
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
      const bank = Math.max(-20, Math.min(20, Math.atan2(vy, Math.abs(vx)) * 180 / Math.PI));
      const flip = vx < 0 ? -1 : 1;
      const scale = 0.68;
      flight.bird.setAttribute(
        'transform',
        `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)}) scale(${(flip * scale).toFixed(3)} ${scale.toFixed(3)}) rotate(${bank.toFixed(1)})`,
      );
      flight.bird.style.opacity = '1';
      if (raw < 1) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
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
    await flyLeg(flight, flight.leg1, false);
    if (!flight.active) break;
    await flyLeg(flight, flight.legHub, false);
    if (!flight.active) break;
    await flyLeg(flight, flight.leg2, false);
    if (!flight.active) break;
    await pause(flight.answerHold);

    flight.bird.classList.add('back');
    await flyLeg(flight, flight.leg2, true);
    if (!flight.active) break;
    await flyLeg(flight, flight.legHub, true);
    if (!flight.active) break;
    await flyLeg(flight, flight.leg1, true);
    if (!flight.active) break;
    await pause(flight.rest);
  }
  flight.bird.remove();
  flight.guides.remove();
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
  const state = connection.online ? 'real' : waiting ? 'connecting' : 'offline';
  el.live.classList.toggle('active', Boolean(connection.online && view?.inFlight));
  el.live.classList.toggle('connecting', state === 'connecting');
  el.live.classList.toggle('offline', state === 'offline');

  if (state === 'real') {
    el.liveState.textContent = '实时';
  } else if (state === 'connecting') {
    el.liveState.textContent = '连接中';
  } else {
    el.liveState.textContent = '未连接';
  }
}

function applyGateway() {
  const address = settings.gateway || '127.0.0.1:3425';
  el.gateway.textContent = address;
  el.hubPort.textContent = address;
  el.fanHubPort.textContent = address;
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
  el.accountToken.textContent = view.tokenDetail || '';
  el.accountToken.hidden = !view.tokenDetail;
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

const ROUTE_COLORS = {
  codex: '#B1A7FF',
  dsh: '#61D7E7',
  claude: '#DDA2FF',
  'claude-code': '#DDA2FF',
  cursor: '#8EB6FF',
  gemini: '#F1C66B',
  opencode: '#8EDCB9',
  qoder: '#F2A98B',
  grok: '#E3D6C7',
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

  const ordered = routes.slice().sort((a, b) => stamp(b) - stamp(a));
  const agents = new Set(ordered.map((route) => route.agent || '')).size;
  const count = ordered.length;
  // The card and the lower half are fixed. The fan gets 134px, so more
  // agents means shorter rows, not a taller window.
  const available = 134;
  const gap = count <= 2 ? 8 : count === 3 ? 3 : count <= 5 ? 2 : 1;
  const maxNode = count === 2 ? 65 : count === 3 ? 44 : count === 4 ? 33 : 30;
  const minNode = count >= 8 ? 12 : count >= 5 ? 14 : 18;
  const nodeHeight = Math.max(
    minNode,
    Math.min(maxNode, Math.floor((available - gap * (count - 1)) / count)),
  );
  el.fan.style.setProperty('--fan-node-h', `${nodeHeight}px`);
  el.fan.style.setProperty('--fan-gap', `${gap}px`);
  el.fan.classList.toggle('dense', count >= 3);
  el.fan.classList.toggle('tight', count >= 2);
  el.fan.classList.toggle('crowded', count >= 3);
  el.fan.classList.toggle('ultra', count >= 4);
  el.fan.classList.toggle('micro', count >= 5);

  el.lanesTitle.textContent = `${count} 个请求正在执行`;
  el.lanesSub.textContent = `${agents} 个 Agent · 各自选择账号`;
  renderStory(present(ordered[0], totals, Boolean(settings.maskAccounts)));

  setParts(el.caption, [
    { text: `${count} 个请求同时经过 magpie`, role: 'strong' },
    { text: ' · 每个 Agent 各自选择账号。', role: 'muted' },
  ]);

  const ids = new Set(ordered.map((route) => String(route.id)));
  for (const id of [...seenRoutes]) {
    if (!ids.has(id)) seenRoutes.delete(id);
  }

  const agentFragment = document.createDocumentFragment();
  const accountFragment = document.createDocumentFragment();
  for (const route of ordered) {
    const id = String(route.id);
    const fresh = !seenRoutes.has(id);
    if (fresh) seenRoutes.add(id);
    const view = present(route, totals, Boolean(settings.maskAccounts));
    const color = agentColor(route.agent);
    agentFragment.append(buildFanAgent(route, view, fresh, color));
  }
  // The account column has its own order, as it does in magpie: a request
  // does not sit level with its account, so the wires cross through the hub.
  const accountOrder = ordered.slice().sort(accountCompare);
  for (const route of accountOrder) {
    const id = String(route.id);
    const fresh = !seenRoutes.has(id);
    const view = present(route, totals, Boolean(settings.maskAccounts));
    const color = agentColor(route.agent);
    accountFragment.append(buildFanAccount(route, view, fresh, color));
  }
  el.fanAgents.replaceChildren(agentFragment);
  el.fanAccounts.replaceChildren(accountFragment);
  el.fanWires.replaceChildren();

  animateNumber(el.statRequests, Number(totals?.requests) || 0);
  animateNumber(el.statRerouted, Number(totals?.rerouted) || 0);
  animateNumber(el.statErrors, Number(totals?.errors) || 0);

  applyUsageTokens();
  el.accountToken.hidden = true;

  syncFlights(ordered, true);
  requestAnimationFrame(() => {
    drawFanWires();
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

  const wire = (d, color, fresh, endX, endY) => {
    const under = document.createElementNS(SVG_NS, 'path');
    under.setAttribute('class', 'fan-wire-under');
    under.setAttribute('d', d);
    under.setAttribute('stroke', color);
    fragment.append(under);

    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('class', `fan-wire-path${fresh ? ' fresh' : ''}`);
    path.setAttribute('d', d);
    path.setAttribute('stroke', color);
    fragment.append(path);

    const end = document.createElementNS(SVG_NS, 'circle');
    end.setAttribute('class', 'fan-wire-end');
    end.setAttribute('cx', String(endX));
    end.setAttribute('cy', String(endY));
    end.setAttribute('r', '1.7');
    end.setAttribute('fill', color);
    fragment.append(end);
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
    wire(d, color, fresh, ax, ay);
  }

  for (const account of accounts) {
    const rect = account.getBoundingClientRect();
    const color = account.style.getPropertyValue('--route') || '#A18BFF';
    const fresh = account.classList.contains('fresh');
    const cx = rect.left - fan.left;
    const cy = rect.top - fan.top + rect.height / 2;
    const d = `M ${hubRight} ${hubY} C ${hubRight + (cx - hubRight) * 0.35} ${hubY}, ${cx - (cx - hubRight) * 0.45} ${cy}, ${cx} ${cy}`;
    wire(d, color, fresh, cx, cy);
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
  return Boolean(route) && (
    !route.done ||
    (Array.isArray(route.tries) && route.tries.some((tryItem) => !tryItem.done))
  );
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
  applyGateway();
  render();
}

async function boot() {
  iconSetup();
  applyGateway();

  const data = await window.busy.bootstrap();
  if (data.version && el.appVersion) el.appVersion.textContent = `v${data.version}`;
  if (data.settings) settings = { ...settings, ...data.settings };
  if (data.connection) connection = data.connection;
  if (data.trace) lastTrace = data.trace;
  if (data.usage) usageData = data.usage;
  applyFrame(data.frame);
  applyGateway();
  setLayout(data.layout);
  render();

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

  new ResizeObserver(() => requestAnimationFrame(drawFanWires)).observe(el.fan);

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && layout) window.busy.endLayout();
  });

  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('drop', (event) => event.preventDefault());
  window.addEventListener('beforeunload', stopFlights);
  setupDragBar();
  setupResizeHandles();
  setupSettingsPanel();
  window.busy.ready?.();
}

boot().catch((error) => {
  connection = { online: false, detail: error?.message || '界面加载失败' };
  render();
});
