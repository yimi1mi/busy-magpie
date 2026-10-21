// The card's words, derived strictly from magpie's trace. Keeping this pure
// makes the widget portable and stops the view from inventing routing facts.

export const ROLE = {
  normal: 'normal',
  strong: 'strong',
  accent: 'accent',
  muted: 'muted',
};

export function shortModel(model) {
  if (!model) return '—';
  const slash = model.indexOf('/');
  if (slash > 0 && slash < model.length - 1 && model.indexOf('/', slash + 1) < 0) {
    return model.slice(slash + 1);
  }
  return model;
}

export function agentName(agent) {
  const id = String(agent || '').trim().toLowerCase();
  switch (id) {
    case 'codex': return 'Codex';
    case 'claude':
    case 'claude-code':
    case 'claudecode': return 'Claude Code';
    case 'claude-desktop': return 'Claude';
    case 'dsh': return 'DeepSeek Harness';
    case 'opencode': return 'OpenCode';
    case 'cursor': return 'Cursor';
    case 'gemini':
    case 'gemini-cli': return 'Gemini';
    case 'qoder': return 'Qoder';
    case 'pi': return 'Pi';
    case 'kimi':
    case 'kimi-code': return 'Kimi Code';
    case 'grok': return 'Grok';
    case 'zcode': return 'ZCode';
    case '': return 'Agent';
    default: return titleCase(id);
  }
}

export function agentGlyph(agent) {
  const id = String(agent || '').trim().toLowerCase();
  switch (id) {
    case 'codex': return '>_';
    case 'claude':
    case 'claude-code':
    case 'claudecode':
    case 'claude-desktop': return '✳';
    case 'dsh': return '◈';
    case 'opencode': return '◇';
    case 'cursor': return '▰';
    case 'gemini':
    case 'gemini-cli': return '✦';
    case 'pi': return 'π';
    case 'kimi':
    case 'kimi-code': return 'K';
    case 'grok': return 'x';
    case 'zcode': return 'Z';
    default: return id ? id.slice(0, 1).toUpperCase() : '…';
  }
}

export function providerName(name, id) {
  const value = String(name || id || '').trim();
  if (!value) return 'magpie';
  switch (value.toLowerCase()) {
    case 'openai': return 'OpenAI';
    case 'codex': return 'Codex';
    case 'anthropic': return 'Anthropic';
    case 'google': return 'Google';
    case 'gemini': return 'Gemini';
    case 'deepseek': return 'DeepSeek';
    case 'openrouter': return 'OpenRouter';
    case 'xai':
    case 'grok': return 'xAI';
    case 'generic': return 'Provider';
    default: return titleCase(value);
  }
}

export function mask(value) {
  if (!value || !value.trim()) return '—';
  const at = value.indexOf('@');
  if (at > 0) {
    const local = value.slice(0, at);
    const domain = value.slice(at + 1);
    const dot = domain.lastIndexOf('.');
    const tld = dot > 0 ? domain.slice(dot) : '';
    const domainHead = dot > 0 ? domain.slice(0, dot) : domain;
    const localMasked = local.length <= 1 ? '•' : `${local.slice(0, 1)}•••`;
    const domainMasked = domainHead.length <= 1 ? '•••' : `${domainHead.slice(0, 1)}•••`;
    return `${localMasked}@${domainMasked}${tld}`;
  }
  if (/^sk-/i.test(value)) return 'sk-••••••••';
  if (value.includes(' ') || value.includes("'")) return value;
  if (value.length <= 2) return '•••';
  if (value.length <= 5) return `${value.slice(0, 1)}•••`;
  return `${value.slice(0, 2)}•••`;
}

export function formatDuration(ms) {
  if (!ms || ms <= 0) return '—';
  if (ms < 1000) return `${ms} 毫秒`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return rest === 0 ? `${minutes} 分` : `${minutes} 分 ${rest} 秒`;
}

export function formatTokens(value) {
  const n = Number(value) || 0;
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

function tokenInfo(route) {
  const usage = Array.isArray(route.usage) ? route.usage[0] : null;
  const prompt = route.prompt || {};
  const input = Number(usage?.in) || 0;
  const output = Number(route.out ?? usage?.out) || 0;
  const cache = Number(usage?.cache_read) || 0;
  const context = Number(prompt.tokens) || 0;
  const window = Number(prompt.window) || 0;
  const total = Number(route.tokens)
    || (input + output + cache)
    || context;
  const cacheRate = input + cache > 0 ? cache / (input + cache) : null;
  const contextPct = window > 0 ? Math.min(1, context / window) : null;

  const detail = [];
  if (output > 0) detail.push(`输出 ${formatTokens(output)}`);
  if (cacheRate !== null) detail.push(`缓存 ${Math.round(cacheRate * 100)}%`);
  if (!detail.length && context > 0) detail.push(`上下文 ${formatTokens(context)}`);

  const title = [
    total > 0 ? `本次 ${formatTokens(total)} token` : '',
    input > 0 ? `输入 ${formatTokens(input)}` : '',
    output > 0 ? `输出 ${formatTokens(output)}` : '',
    cache > 0
      ? `缓存 ${formatTokens(cache)}${cacheRate !== null ? `（${Math.round(cacheRate * 100)}%）` : ''}`
      : '',
    window > 0
      ? `上下文 ${formatTokens(context)} / ${formatTokens(window)}${contextPct !== null ? `（${Math.round(contextPct * 100)}%）` : ''}`
      : '',
  ].filter(Boolean).join(' · ');

  return { total, detail: detail.join(' · '), title, contextPct };
}

// The account's own allowance, as its order entry carries it: "known" says
// the vendor told magpie what is left, "used" is the share of the window
// the model counts against. A key with no subscription has neither.
function quotaInfo(picked) {
  if (!picked || !picked.known) return null;
  const used = Number(picked.used);
  if (!Number.isFinite(used)) return null;
  const renews = Array.isArray(picked.renews) ? picked.renews : [];
  return {
    used: Math.max(0, Math.min(100, used)),
    remaining: Math.max(0, Math.min(100, 100 - used)),
    renewAt: picked.usedRenews || renews[0] || '',
    amount: Number(picked.amount) || 0,
    limit: Number(picked.limit) || 0,
    unit: String(picked.unit || ''),
  };
}

// Output tokens a second, read the way magpie's own Routing page reads them:
// the reply's output, less its reasoning when the answer started after it,
// over the window from its first streamed token to its end. A reply that came
// in one burst at its end has no speed, and neither has one still streaming:
// magpie counts output only when the reply ends.
function speedInfo(route, lastTry) {
  if (!route.done) return null;
  const out = Number(route.out) || 0;
  const usage = Array.isArray(route.usage) ? route.usage[route.usage.length - 1] : null;
  const think = Number(route.reasoning) || Number(usage?.reasoning) || 0;
  const ms = Number(route.ms) || 0;
  const ttft = Number(route.ttft) || Number(lastTry?.ttft) || 0;
  const firstText = Number(route.firstText) || 0;
  const firstReasoning = Number(route.firstReasoning) || 0;
  const flow = Number(route.flow) || 0;
  if (!out || !ms || !ttft) return null;
  if (route.reasoningHidden && firstText <= 0) return null;
  const visible = think > 0 && firstText <= 0 && firstReasoning >= ttft && flow > 0 && think <= out;
  const tokens = think > 0 && !visible ? out - think : out;
  const from = visible ? firstReasoning : think > 0 ? firstText : ttft;
  const window = ms - from;
  if (!(tokens > 0 && from > 0 && window >= 100 && tokens * 1000 <= 10000 * window)) return null;
  // Held back, then let go: its content came in under a quarter of its window.
  if (flow > 0 && flow * 4 < window) return null;
  // Reasoning that took far longer than the answer it preceded is not a pace.
  if (think > 0 && firstText > 0 && tokens * (firstText - ttft) > 20 * think * window) return null;
  return { rate: (tokens * 1000) / window, tokens, window };
}

// How long the request took to start answering, and where the wait sat.
function timingInfo(route, lastTry) {
  const net = lastTry && lastTry.net ? lastTry.net : null;
  const ms = Number(route.ms) || 0;
  const ttft = Number(route.ttft) || Number(lastTry?.ttft) || 0;
  if (!ms && !ttft) return null;
  return {
    ms,
    ttft,
    speed: speedInfo(route, lastTry),
    wait: Number(net?.wait) || 0,
    own: Number(net?.own) || 0,
    queued: Number(route.queued) || 0,
  };
}

// How long until an allowance renews, in the fewest words that stay true.
export function formatEta(iso) {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const ms = at.getTime() - Date.now();
  if (ms <= 0) return '即将续期';
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return '1 小时内续';
  if (hours < 48) return `${hours} 小时后续`;
  const days = Math.round(ms / 86_400_000);
  if (days < 30) return `${days} 天后续`;
  const month = at.getMonth() + 1;
  return `${month}/${at.getDate()} 续`;
}

export function timeOf(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
}

export function present(route, totals, maskAccounts) {
  if (!route) return empty(totals);
  const tries = Array.isArray(route.tries) ? route.tries : [];
  const order = Array.isArray(route.order) ? route.order : [];
  const lastTry = tries.length ? tries[tries.length - 1] : null;
  const picked = (lastTry && order.find((item) => item.id === lastTry.id)) || order[0] || null;
  const inFlight = !route.done || tries.some((item) => !item.done);
  // A failed earlier try that handed the request on is part of the story,
  // not a failed request. Only the route's own outcome decides the card.
  const failed = Number(route.status) >= 400 || Boolean(route.error) ||
    Boolean(lastTry && lastTry.done && Number(lastTry.status) >= 400);

  const agent = agentName(route.agent);
  const model = shortModel(route.model);
  const accountModel = shortModel(lastTry?.model || picked?.model || route.served || route.model);
  const provider = providerName(picked?.name, route.provider);
  const rawWho = who(route, picked, provider);
  const kind = kindWord(picked, provider);
  const maskable = picked?.kind === 'account' || picked?.kind === 'key';
  const visibleWho = maskAccounts && maskable ? mask(rawWho) : rawWho;
  const count = Math.max(order.length, picked ? 1 : 0);
  const single = count <= 1;
  const accountState = stateText(route, lastTry, failed, inFlight, true);
  const storyState = stateText(route, lastTry, failed, inFlight, false);
  const agentModel = route.provider && String(route.provider).toLowerCase() !== 'openai'
    ? `${route.provider}/${model}`
    : model;
  const token = tokenInfo(route);

  return {
    hasRoute: true,
    inFlight,
    failed,
    agentName: agent,
    agentId: route.agent || '',
    agentGlyph: agentGlyph(route.agent),
    agentModel,
    providerName: provider,
    providerIcon: picked?.icon || 'generic',
    accountName: visibleWho,
    accountModel,
    accountState,
    accountPlan: picked?.plan ? picked.plan.toUpperCase() : '',
    tokens: token.total,
    tokenDetail: token.detail,
    tokenTitle: token.title,
    tokenPct: token.contextPct,
    quota: quotaInfo(picked || lastTry),
    timing: timingInfo(route, lastTry),
    timeText: timeOf(route.time),
    caption: caption(route, visibleWho, model, kind, count, single),
    story: story(route, agent, model, provider, visibleWho, accountModel, kind, storyState, inFlight, failed),
    requests: Number(totals?.requests) || 0,
    rerouted: Number(totals?.rerouted) || 0,
    errors: Number(totals?.errors) || 0,
  };
}

export function empty(totals) {
  return {
    hasRoute: false,
    inFlight: false,
    failed: false,
    agentName: '等待 Agent',
    agentGlyph: '…',
    agentModel: '尚无请求',
    providerName: 'magpie',
    providerIcon: 'generic',
    accountName: '等待路由',
    accountModel: '—',
    accountState: '空闲',
    accountPlan: '',
    timeText: '',
    caption: [
      { text: 'magpie 已连接。', role: ROLE.strong },
      { text: ' 下一个经过网关的请求会在这里实时展开。', role: ROLE.muted },
    ],
    story: [],
    requests: Number(totals?.requests) || 0,
    rerouted: Number(totals?.rerouted) || 0,
    errors: Number(totals?.errors) || 0,
  };
}

export function connecting(lastTotals) {
  const view = empty(lastTotals);
  return {
    ...view,
    agentName: '正在连接',
    agentGlyph: '…',
    agentModel: 'magpie 路由',
    accountName: '等待网关',
    accountState: '连接中',
    caption: [
      { text: '正在读取 magpie 的实时路由。', role: ROLE.strong },
      { text: ' 网关启动后，这里会自动亮起来。', role: ROLE.muted },
    ],
    story: [
      { parts: [{ text: '正在连接本机网关…', role: ROLE.muted }], bullet: 'quiet' },
    ],
  };
}

export function offline(detail, gateway, lastTotals) {
  const view = empty(lastTotals);
  const why = detail ? `（${detail}）` : '';
  return {
    ...view,
    agentName: 'magpie 未连接',
    agentGlyph: '!',
    agentModel: '路由暂停',
    accountName: '等待网关',
    accountState: '离线',
    caption: [
      { text: '没有找到 magpie 的网关', role: ROLE.strong },
      { text: ` · ${gateway}${why}。`, role: ROLE.muted },
      { text: ' 启动 magpie 后会自动恢复。', role: ROLE.muted },
    ],
    story: [
      {
        parts: [
          { text: '网关恢复后，', role: ROLE.muted },
          { text: '最近的请求', role: ROLE.strong },
          { text: ' 会在这里重新展开。', role: ROLE.muted },
        ],
        bullet: 'quiet',
      },
    ],
  };
}

function caption(route, who, model, kind, count, single) {
  if (route.group && route.group.name) {
    return [
      { text: '路由组 ', role: ROLE.muted },
      { text: route.group.name, role: ROLE.accent },
      { text: ' 在 ', role: ROLE.muted },
      { text: String(count), role: ROLE.strong },
      { text: ' 个成员中选择了 ', role: ROLE.muted },
      { text: model, role: ROLE.accent },
      { text: '。', role: ROLE.muted },
    ];
  }
  if (!route.order || route.order.length === 0) {
    return [
      { text: '没有可用的', role: ROLE.muted },
      { text: kind, role: ROLE.strong },
      { text: '，请求还在等待。', role: ROLE.muted },
    ];
  }
  if (route.pinned) {
    return [
      { text: '本次指定了 ', role: ROLE.muted },
      { text: who, role: ROLE.strong },
      { text: '，其余候选不参与。', role: ROLE.muted },
    ];
  }
  if (single) {
    return [
      { text: who, role: ROLE.strong },
      { text: ' 是 ', role: ROLE.muted },
      { text: model, role: ROLE.accent },
      { text: ` 唯一启用的${kind}，无需选择。`, role: ROLE.muted },
    ];
  }
  return [
    { text: '在 ', role: ROLE.muted },
    { text: String(count), role: ROLE.strong },
    { text: ` 个${kind}中选择了 `, role: ROLE.muted },
    { text: who, role: ROLE.strong },
    { text: '。', role: ROLE.muted },
  ];
}

function story(route, agent, model, provider, who, accountModel, kind, state, inFlight, failed) {
  const lines = [
    {
      parts: [
        { text: agent, role: ROLE.strong },
        { text: ' 请求 ', role: ROLE.muted },
        { text: model, role: ROLE.accent },
        { text: ' → ', role: ROLE.muted },
        { text: provider, role: ROLE.strong },
      ],
      bullet: 'quiet',
    },
    {
      parts: caption(route, who, model, kind, Math.max(route.order?.length || 1, 1), (route.order?.length || 0) <= 1),
      bullet: 'quiet',
    },
  ];

  const parts = [
    { text: who, role: ROLE.strong },
    { text: ` (${accountModel})`, role: ROLE.muted },
  ];
  if (route.effort) {
    parts.push({ text: ' 以 ', role: ROLE.muted });
    parts.push({ text: route.effort, role: ROLE.accent });
    parts.push({ text: ' 推理强度 ', role: ROLE.muted });
  } else {
    parts.push({ text: ' ', role: ROLE.muted });
  }
  parts.push({ text: state, role: failed ? ROLE.strong : ROLE.normal });
  lines.push({ parts, bullet: inFlight ? 'pulse' : failed ? 'failed' : 'done' });
  return lines;
}

function stateText(route, lastTry, failed, inFlight, forAccount) {
  if (failed) {
    return `回答失败${Number(route.status) > 0 ? ` · ${route.status}` : ''}`;
  }
  if (inFlight) {
    return lastTry && !lastTry.done ? '回答中…' : '排队中…';
  }
  if (forAccount) return '回答了这个请求';
  // The newest reply keeps its speed here, so it stays readable while the
  // next request is already running and the stage above shows that one.
  const speed = speedInfo(route, lastTry);
  const rate = speed ? ` · ${Math.round(speed.rate)} tok/s` : '';
  return `已回答 · ${formatDuration(route.ms)}${rate}`;
}

function who(route, picked, provider) {
  if (picked?.who && picked.who.trim()) return picked.who.trim();
  if (picked?.name && picked.name.trim()) return picked.name.trim();
  if (route.pinned) return String(route.pinned).trim();
  return provider;
}

function kindWord(picked, provider) {
  if (picked?.kind === 'account') return '账号';
  if (picked?.kind === 'key') return 'Key';
  if (picked?.kind === 'provider') return '服务商';
  return provider ? '服务商' : '账号';
}

function titleCase(value) {
  return value
    .replace(/[-_]/g, ' ')
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
