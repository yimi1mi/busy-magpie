import { requestActive, requestGroupKey } from './request-model.mjs';

export const ROUTE_LINGER_MS = 12000;
const timestamp = value => Date.parse(value);
const succeeds = attempt => Boolean(attempt?.done) && Number(attempt.status) < 400 && !attempt.fail;
const order = (a, b) => (timestamp(a.time) || 0) - (timestamp(b.time) || 0)
  || String(a.id).localeCompare(String(b.id), undefined, { numeric: true });

export function completedAt(route) {
  return timestamp(route.time) + Math.max(0, Number(route.ms) || 0);
}

// Keep Routing's twelve-second completion window at the widget's existing
// Agent/session granularity. The latest request remains as the overview.
export function stagedRoutes(routes, playing = new Set(), now = Date.now()) {
  const sorted = [...routes].sort(order);
  const latest = sorted.at(-1);
  const groups = new Map(sorted.map(route => [requestGroupKey(route), route]));
  let nextExpiry = Infinity;
  const selected = sorted.filter(route => {
    if (requestActive(route) || playing.has(String(route.id)) || route === latest) return true;
    if (groups.get(requestGroupKey(route)) !== route) return false;
    const expires = completedAt(route) + ROUTE_LINGER_MS;
    if (!(expires > now)) return false;
    nextExpiry = Math.min(nextExpiry, expires);
    return true;
  });
  return { routes: selected, nextExpiry };
}

function restUntil(route) {
  const attempt = route.tries?.at(-1);
  if (succeeds(attempt)) return NaN;
  const candidate = (route.order || []).find(item => item.id === attempt?.id
    && (!attempt?.model || !item.model || item.model === attempt.model)) || (!attempt ? route.order?.[0] : null);
  const values = [attempt?.rest?.until, candidate?.rest?.until].map(timestamp).filter(Number.isFinite);
  return values.length ? Math.max(...values) : NaN;
}

export function nextRestExpiry(routes, now) {
  return routes.reduce((next, route) => {
    const until = restUntil(route);
    return until > now ? Math.min(next, until) : next;
  }, Infinity);
}

// Match Routing's live/lit/rest states. A completed source wire goes neutral;
// its successful account wire stays lit, without the moving request packet.
export function wireState(routes, side, onWire = new Set(), now = Date.now()) {
  const states = routes.map(route => {
    const attempts = route.tries || [];
    const attempt = attempts.at(-1);
    const moving = attempts.some(item => !item.done) || (attempts.length > 0 && onWire.has(String(route.id)));
    if (side === 'in') return moving ? 'live' : 'idle';
    if (restUntil(route) > now) return 'rest';
    if (moving) return 'live';
    if (succeeds(attempt)) return 'lit';
    return 'idle';
  });
  if (states.includes('live')) return 'live';
  if (states.includes('lit')) return 'lit';
  return states.length && states.every(state => state === 'rest') ? 'rest' : 'idle';
}
