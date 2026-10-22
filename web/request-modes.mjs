const word = value => typeof value === 'string' ? value.trim() : '';
const lower = value => word(value).toLowerCase();

function attemptProvider(route, attempt) {
  const candidates = [...(Array.isArray(route?.order) ? route.order : []),
    ...(Array.isArray(route?.left) ? route.left : [])];
  const seat = attempt && candidates.find(item => item.id === attempt.id
    && (!attempt.model || !item.model || item.model === attempt.model));
  // A group can fall back to another provider. Its original provider is not
  // evidence for the provider of a try whose seat was not recorded.
  return lower(seat?.provider || (route?.group ? '' : route?.provider));
}

function tierName(value, provider) {
  switch (lower(value)) {
    case 'fast': return 'Fast';
    case 'ultrafast': return 'Ultrafast';
    case 'priority': return provider === 'openai' ? 'Fast' : value;
    default: return value;
  }
}

function tierDetail(value, provider) {
  if (!value) return '未提供';
  const name = tierName(value, provider);
  return name === value ? value : `${value}（${name}）`;
}

function tierKind(value, provider) {
  const name = tierName(value, provider);
  return name === 'Fast' || name === 'Ultrafast' ? 'fast' : value ? 'other' : '';
}

// These are request observations, not the agent's global configuration or a
// measurement of model speed. A missing value never supplies a default.
export function projectRequestModes(route) {
  const attempts = Array.isArray(route?.tries) ? route.tries : [];
  const attempt = attempts.at(-1);
  const askedEffort = word(route?.effort);
  const sentEffort = word(attempt?.effort);
  const askedTier = word(route?.tier);
  const sentTier = word(attempt?.tier);
  const reportedTier = word(attempt?.tierServed);
  const askedProvider = lower(route?.provider);
  const sentProvider = attemptProvider(route, attempt);
  const speedSource = reportedTier ? 'reported' : sentTier ? 'sent' : askedTier ? 'asked' : '';
  const effortSource = sentEffort ? 'sent' : askedEffort ? 'asked' : '';
  const speedValue = reportedTier || sentTier || askedTier;
  const effortValue = sentEffort || askedEffort;
  const speedName = tierName(speedValue, speedSource === 'asked' ? askedProvider : sentProvider);
  const speedKind = tierKind(speedValue, speedSource === 'asked' ? askedProvider : sentProvider);
  const sourceLabel = { asked: '请求', sent: '已发送', reported: '回报' }[speedSource];
  const speedLabel = speedValue ? `${speedName} ${sourceLabel}` : '';
  const requestSpeedValue = askedTier || sentTier;
  const requestEffortValue = askedEffort || sentEffort;
  const requestSource = { speed: askedTier ? 'asked' : sentTier ? 'sent' : '',
    effort: askedEffort ? 'asked' : sentEffort ? 'sent' : '' };
  const requestSpeedKind = tierKind(requestSpeedValue, askedTier ? askedProvider : sentProvider);
  const effortLabel = askedEffort && sentEffort && askedEffort !== sentEffort
    ? `${askedEffort} → ${sentEffort}` : effortValue;
  const details = [
    `推理强度请求：${askedEffort || '未提供'}`,
    `发送推理强度：${sentEffort || '未提供'}`,
    `速度档位请求：${tierDetail(askedTier, askedProvider)}`,
    `发送速度档位：${tierDetail(sentTier, sentProvider)}`,
    `服务端档位回报：${tierDetail(reportedTier, sentProvider)}`,
  ];
  if (attempt?.fast === true) details.push('路由成员要求 Fast；该标记不证明已发送或实际采用 Fast。');
  if ([askedTier, sentTier, reportedTier].some(value => lower(value) === 'priority')
    && ((lower(askedTier) === 'priority' && askedProvider !== 'openai')
      || ([sentTier, reportedTier].some(value => lower(value) === 'priority') && sentProvider !== 'openai'))) {
    details.push('priority 保留服务档位原词；未确认是 OpenAI Fast。');
  }
  if (lower(sentProvider) === 'anthropic' && reportedTier) {
    details.push('此处回报为 service_tier，不代表 Claude 的 usage.speed。');
  }
  return {
    askedEffort, sentEffort, askedTier, sentTier, reportedTier,
    speedLabel, effortLabel, speedValue, effortValue, speedKind,
    requestSpeedKind, requestSpeedValue, requestEffortValue, requestSource,
    details: details.join('\n'),
    source: { speed: speedSource, effort: effortSource },
    hasData: Boolean(speedValue || effortValue),
  };
}

export function isConversationRequest(route) {
  if (!route || route.for) return false;
  const kind = lower(route.kind);
  // Unknown feature kinds are not allowed to overwrite a conversation's mode.
  return kind === '' || kind === 'collab_spawn' || kind === 'subagent';
}

export function latestModeRoute(routes) {
  if (!routes.length) return null;
  const identities = new Set(routes.map(route => `${route.agent || 'unknown'}|${route.session || route.conv || ''}`));
  if (identities.size !== 1 || (routes.length > 1 && !routes[0].session && !routes[0].conv)) return null;
  const conversations = routes.filter(isConversationRequest);
  // An explicitly identified child can show its own mode. If a client puts
  // parent and child requests under one identity, keep the parent's mode.
  const ordinary = conversations.filter(route => !word(route.kind) && !route.subagentId && !route.sub);
  const candidates = ordinary.length ? ordinary : conversations;
  return candidates.reduce((latest, route) => {
    if (!latest) return route;
    const byTime = (Date.parse(route.time) || 0) - (Date.parse(latest.time) || 0);
    return byTime > 0 || (byTime === 0 && String(route.id).localeCompare(String(latest.id), undefined, { numeric: true }) > 0)
      ? route : latest;
  }, null);
}
