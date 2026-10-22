const agents = {
  codex: 'openai', openai: 'openai',
  claude: 'claudecode-color', 'claude-code': 'claudecode-color', claudecode: 'claudecode-color',
  'claude-desktop': 'claude-color',
  dsh: 'deepseek-color', deepseek: 'deepseek-color', cursor: 'cursor', opencode: 'opencode',
  gemini: 'gemini-color', 'gemini-cli': 'geminicli-color', geminicli: 'geminicli-color',
  kimi: 'kimi', 'kimi-code': 'kimi', qoder: 'qoder', pi: 'pi', grok: 'grok', zcode: 'zhipu-color',
};
const providers = {
  openai: 'openai', codex: 'openai', anthropic: 'anthropic', claude: 'claude-color',
  google: 'google-color', gemini: 'gemini-color', deepseek: 'deepseek-color',
  openrouter: 'openrouter', xai: 'xai', grok: 'grok', kimi: 'kimi', moonshot: 'kimi',
  qwen: 'qwen-color', zhipu: 'zhipu-color', zcode: 'zhipu-color',
};

export function brandKey(value, kind = 'agent') {
  const key = String(value || '').trim().toLowerCase().replace(/\.svg$/, '').replace(/-color$/, '');
  return (kind === 'provider' ? providers : agents)[key] || '';
}

const templates = new Map();
export function brandMark(key, sources) {
  if (!key || !sources?.[key]) return null;
  if (!templates.has(key)) {
    const svg = new DOMParser().parseFromString(sources[key], 'image/svg+xml').documentElement;
    if (svg.localName !== 'svg') return null;
    svg.removeAttribute('style');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'brand-mark');
    svg.dataset.brand = key;
    templates.set(key, svg);
  }
  return document.importNode(templates.get(key), true);
}
