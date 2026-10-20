const api = window.settingsApi;
const $ = (id) => document.getElementById(id);

const form = $('settingsForm');
const topmost = $('topmost');
const maskAccounts = $('maskAccounts');
const opacity = $('opacity');
const opacityOut = $('opacityOut');
const gateway = $('gateway');
const gatewayHint = $('gatewayHint');
const width = $('width');
const height = $('height');
const settingsPath = $('settingsPath');
const rawSettings = $('rawSettings');
const status = $('status');
const save = $('save');

let busy = false;

function setStatus(message, error = false) {
  status.textContent = message || '';
  status.classList.toggle('error', error);
}

function applyOpacityLabel() {
  opacityOut.textContent = `${opacity.value}%`;
}

function fill(data) {
  const s = data.settings || {};
  topmost.checked = Boolean(s.topmost);
  maskAccounts.checked = Boolean(s.maskAccounts);
  opacity.value = String(Math.round((Number(s.opacity) || 1) * 100));
  applyOpacityLabel();
  gateway.value = s.gateway || '';
  gateway.placeholder = `留空自动检测（当前 ${data.resolvedGateway || '127.0.0.1:3425'}）`;
  gatewayHint.textContent = `当前连接：${data.resolvedGateway || '127.0.0.1:3425'}`;
  width.value = String(s.width || 632);
  height.value = String(s.height || 432);
  settingsPath.textContent = data.path || '';
  rawSettings.textContent = data.raw || '';
}

async function load() {
  const bird = $('settingsBird');
  if (bird && api.icons?.magpie) bird.setAttribute('d', api.icons.magpie);
  try {
    fill(await api.get());
  } catch (error) {
    setStatus(error?.message || '读取设置失败', true);
  }
}

opacity.addEventListener('input', applyOpacityLabel);

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy) return;
  busy = true;
  save.disabled = true;
  setStatus('保存中…');
  try {
    const result = await api.save({
      topmost: topmost.checked,
      maskAccounts: maskAccounts.checked,
      opacity: Number(opacity.value) / 100,
      gateway: gateway.value.trim(),
      width: Number(width.value),
      height: Number(height.value),
    });
    if (!result?.ok) {
      setStatus(result?.error || '保存失败', true);
      return;
    }
    if (result.settings) fill({ ...result, settings: result.settings });
    setStatus('已保存');
  } catch (error) {
    setStatus(error?.message || '保存失败', true);
  } finally {
    busy = false;
    save.disabled = false;
  }
});

$('cancel').addEventListener('click', () => api.close());
$('openFile').addEventListener('click', () => api.openFile());

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') api.close();
});

load();
