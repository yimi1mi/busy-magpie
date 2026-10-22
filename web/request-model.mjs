export const requestActive = route => Boolean(route) && (!route.done || (route.tries || []).some(item => !item.done));
export const requestFailed = route => Boolean(route) && !requestActive(route)
  && (Number(route.status) >= 400 || Boolean(route.error) || Number(route.tries?.at(-1)?.status) >= 400);
export const requestGroupKey = route => `${route.agent || 'unknown'}|${route.session || route.conv || ''}`;

export function recentRequests(trace, filter = 'all', limit = 20) {
  return (Array.isArray(trace?.routes) ? trace.routes : [])
    .filter(route => filter === 'active' ? requestActive(route) : filter === 'failed' ? requestFailed(route) : true)
    .slice().sort((a, b) => (Date.parse(b.time) || 0) - (Date.parse(a.time) || 0)
      || String(b.id).localeCompare(String(a.id))).slice(0, limit);
}

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

export function errorAdvice(status) {
  if (status === 401) return '上游未接受凭据，可到 magpie 检查账号登录状态。';
  if (status === 403) return '上游拒绝访问，可检查模型或账号权限。';
  if (status === 429) return '上游限制了请求；可能是速率或额度限制，具体以错误详情为准。';
  if (status >= 500) return '上游或网关返回服务错误，可结合各次尝试判断故障位置。';
  return '具体原因以网关记录的错误详情为准。';
}

export function attemptRows(route, maskAccounts = true) {
  return (route?.tries || []).map((attempt, index, tries) => {
    const candidateIndex = (route.order || []).findIndex(item => item.id === attempt.id);
    const candidate = route.order?.[candidateIndex];
    const privateName = candidate?.kind === 'account' || candidate?.kind === 'key';
    const name = maskAccounts && privateName ? `${candidate.kind === 'key' ? 'Key' : '账号'} ${candidateIndex + 1}`
      : candidate?.who || candidate?.name || `候选 ${index + 1}`;
    const failed = Number(attempt.status) >= 400 || Boolean(attempt.error);
    const handedOn = failed && (index < tries.length - 1 || requestActive(route));
    return { index: index + 1, name, model: attempt.model || route.model || '—',
      state: !attempt.done ? '等待响应' : handedOn ? '失败后改道' : failed ? '尝试失败' : '成功',
      failed, handedOn, status: Number(attempt.status) || 0, ms: Number(attempt.ms) || 0,
      error: redactDiagnostic(attempt.error || ''), };
  });
}

export function requestSummary(route, agentLabel = route?.agent || 'Agent') {
  const attempts = attemptRows(route, true);
  return redactDiagnostic([
    `${agentLabel} · ${route.model || '未知模型'} · 请求 #${route.id}`,
    `状态：${requestActive(route) ? '进行中' : requestFailed(route) ? '失败' : '已完成'}${route.status ? ` · HTTP ${route.status}` : ''}`,
    `时间：${route.time || '—'}`,
    ...attempts.map(item => `${item.index}. ${item.name} · ${item.model} · ${item.state}${item.status ? ` · HTTP ${item.status}` : ''}${item.ms ? ` · ${item.ms}ms` : ''}${item.error ? `\n   ${item.error}` : ''}`),
    route.error ? `错误：${redactDiagnostic(route.error)}` : '',
  ].filter(Boolean).join('\n'), 10000);
}

export class RequestSelection {
  following = true;
  snapshot = null;
  pid = null;
  previousGateway = false;

  update(trace) {
    const pid = Number(trace?.pid) || 0;
    if (this.following) {
      this.snapshot = recentRequests(trace)[0] || null;
      this.pid = pid;
      this.previousGateway = false;
    } else {
      this.previousGateway = pid !== this.pid;
      if (!this.previousGateway) {
        this.snapshot = (trace?.routes || []).find(row => String(row.id) === String(this.snapshot?.id)) || this.snapshot;
      }
    }
    return this.snapshot;
  }
  select(route, trace) { this.following = false; this.snapshot = route; this.pid = Number(trace?.pid) || 0; this.previousGateway = false; }
  follow(trace) { this.following = true; return this.update(trace); }
}
