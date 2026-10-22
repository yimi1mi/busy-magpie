export const requestActive = route => Boolean(route) && (!route.done || (route.tries || []).some(item => !item.done));
export const requestGroupKey = route => `${route.agent || 'unknown'}|${route.session || route.conv || ''}`;

export function groupRequests(routes, { includeCompleted = false } = {}) {
  const groups = new Map();
  for (const route of includeCompleted ? routes : routes.filter(requestActive)) {
    const session = String(route.session || route.conv || '');
    const key = requestGroupKey(route);
    let group = groups.get(key);
    if (!group) {
      group = { key, session, agent: route.agent || '', routes: [] };
      groups.set(key, group);
    }
    group.routes.push(route);
  }
  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key)).map(group => {
    group.routes.sort((a, b) => (Date.parse(a.time) || 0) - (Date.parse(b.time) || 0) || String(a.id).localeCompare(String(b.id)));
    group.route = group.routes[0];
    group.context = group.route.folder || (group.session ? `会话 ${group.session.slice(-6)}` : '未提供会话');
    const accounts = group.routes.map(route => {
      const id = route.tries?.at(-1)?.id || route.order?.[0]?.id;
      return id ? `${route.provider || ''}/${id}` : null;
    });
    group.accountCount = new Set(accounts.filter(Boolean)).size;
    group.pendingAccounts = accounts.filter(id => !id).length;
    group.modelCount = new Set(group.routes.map(route => route.model)).size;
    return group;
  });
}

export function redactDiagnostic(value, limit = 1800) {
  const safe = String(value || '')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, '$1 [已隐藏]')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[Key 已隐藏]')
    .replace(/((?:api[_-]?key|token|secret|password|authorization)["']?\s*[:=]\s*["']?)[^\s,"';}]+/gi, '$1[已隐藏]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[邮箱已隐藏]')
    .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, '$1[凭据已隐藏]@');
  return safe.length > limit ? `${safe.slice(0, limit)}\n…（已截断）` : safe;
}
