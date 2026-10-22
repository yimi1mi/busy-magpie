const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../web/app.js'), 'utf8');
const start = source.indexOf('function setupSettingsPanel()');
const end = source.indexOf('\nlet aboutRefresh', start);
assert.ok(start >= 0 && end > start, 'load the actual renderer settings panel');
const setup = source.slice(start, end);
const flush = () => new Promise(setImmediate);

function panelHarness(savedOpacity = 1) {
  const elements = new Map();
  const loads = [];
  const previews = [];
  const restorations = [];
  let onPanel;
  let surface = savedOpacity;
  const element = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        value: '', textContent: '', hidden: true, style: {}, dataset: {}, handlers: {},
        classList: { add() {}, remove() {}, toggle() {} },
        setAttribute() {}, getAttribute() {},
        addEventListener(name, handler) { this.handlers[name] = handler; },
      });
    }
    return elements.get(id);
  };
  const settings = { opacity: savedOpacity };
  const context = {
    $: element, settings, USAGE_PERIODS: ['today'], aboutRefresh: null,
    connection: { online: true }, usageStatus: {}, usageData: null,
    applySurface(value) { surface = value; restorations.push(value); },
    document: {
      querySelectorAll: () => [],
      body: { classList: { add() {}, remove() {} } },
    },
    window: {
      clearTimeout() {}, setTimeout() {}, addEventListener() {},
      busy: {
        settingsGet: () => new Promise((resolve) => loads.push(resolve)),
        previewOpacity(value) { surface = value; previews.push(value); },
        onHotkeyCapture() {},
        onSettingsPanel(handler) { onPanel = handler; },
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(`${setup}\nsetupSettingsPanel();`, context);
  return {
    element, settings, previews, restorations,
    surface: () => surface,
    open() { onPanel({ open: true, mode: 'settings' }); },
    close() { onPanel({ open: false }); },
    input(percent) {
      element('settingsOpacity').value = String(percent);
      element('settingsOpacity').handlers.input();
    },
    async resolveLoad(index, values = {}) {
      loads[index]({ settings: { opacity: savedOpacity, ...values }, version: 'test' });
      await flush();
      assert.equal(element('settingsStatus').textContent, '');
    },
  };
}

test('closing after load and preview restores saved background synchronously', async () => {
  const h = panelHarness(0.75);
  h.open();
  await h.resolveLoad(0);
  h.input(0);
  assert.equal(h.surface(), 0);
  h.close();
  assert.equal(h.surface(), 0.75);
  assert.deepEqual(h.previews, [0]);
  assert.deepEqual(h.restorations, [0.75]);
});

test('a settings reply arriving after slider input preserves the draft and cancellation', async () => {
  const h = panelHarness(0.75);
  h.open();
  h.input(0);
  await h.resolveLoad(0);
  assert.equal(h.element('settingsOpacity').value, '0');
  assert.equal(h.element('settingsOpacityOut').textContent, '0%');
  assert.equal(h.surface(), 0);
  h.close();
  assert.equal(h.surface(), 0.75);
  assert.deepEqual(h.restorations, [0.75]);
});

test('cancellation uses the current saved opacity including zero', async () => {
  const h = panelHarness(0.6);
  h.open();
  await h.resolveLoad(0);
  h.input(80);
  h.settings.opacity = 0;
  h.close();
  assert.equal(h.surface(), 0);
  assert.deepEqual(h.restorations, [0]);
});

test('a settings reply after closing cannot overwrite the cancelled draft', async () => {
  const h = panelHarness(0.8);
  h.open();
  h.input(15);
  h.close();
  assert.equal(h.surface(), 0.8);
  await h.resolveLoad(0);
  assert.equal(h.element('settingsOpacity').value, '15');
  assert.equal(h.surface(), 0.8);
});

test('a reply from an earlier opening cannot overwrite the current settings form', async () => {
  const h = panelHarness();
  h.open();
  h.close();
  h.open();
  await h.resolveLoad(1, { opacity: 0.6, gateway: 'new-gateway' });
  await h.resolveLoad(0, { opacity: 0.2, gateway: 'old-gateway' });
  assert.equal(h.element('settingsOpacity').value, '60');
  assert.equal(h.element('settingsGateway').value, 'new-gateway');
});
