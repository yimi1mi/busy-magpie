'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');

function readAsset(name) {
  try {
    return fs.readFileSync(path.join(__dirname, '..', 'assets', name), 'utf8').trim();
  } catch {
    return '';
  }
}

contextBridge.exposeInMainWorld('busy', {
  platform: process.platform,
  brandIcons: Object.fromEntries(fs.readdirSync(path.join(__dirname, '..', 'assets', 'brands'))
    .filter(name => name.endsWith('.svg')).map(name => [name.slice(0, -4), readAsset(`brands/${name}`)])),
  icons: {
    magpie: readAsset('magpie-path.txt'),
    openai: readAsset('openai-path.txt'),
    deepseek: readAsset('deepseek-path.txt'),
  },
  bootstrap: () => ipcRenderer.invoke('busy:bootstrap'),
  ready: () => ipcRenderer.send('busy:ready'),
  endLayout: () => ipcRenderer.send('busy:end-layout'),
  dragStart: () => ipcRenderer.send('busy:drag-start'),
  dragEnd: () => ipcRenderer.send('busy:drag-end'),
  resizeStart: (direction) => ipcRenderer.send('busy:resize-start', direction),
  resizeEnd: () => ipcRenderer.send('busy:resize-end'),
  setUsagePeriod: (period) => ipcRenderer.invoke('usage:set-period', period),
  setHitAreas: (areas) => ipcRenderer.send('busy:hit-areas', areas),
  // Resolves with the state main settled on, so the renderer never has to
  // guess whether its menu is really open.
  toggleMenu: () => ipcRenderer.invoke('busy:menu-toggle'),
  // Read back the authoritative menu state and let the renderer leave a
  // breadcrumb in the same log main writes to.
  menuState: () => ipcRenderer.invoke('busy:menu-state'),
  log: (message) => ipcRenderer.send('busy:log', message),
  closeMenu: () => ipcRenderer.send('busy:menu-close'),
  toggleCompact: () => ipcRenderer.send('busy:compact-toggle'),
  menuAction: (action) => ipcRenderer.send('busy:menu-action', action),
  copySummary: (text) => ipcRenderer.invoke('busy:copy-summary', text),
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsSave: (data) => ipcRenderer.invoke('settings:save', data),
  testGateway: (raw) => ipcRenderer.invoke('gateway:test', raw),
  resetPlacement: () => ipcRenderer.invoke('window:reset'),
  previewOpacity: (value) => ipcRenderer.send('settings:opacity', value),
  settingsOpenFile: () => ipcRenderer.send('settings:open-file'),
  settingsClose: () => ipcRenderer.send('settings:close'),
  aboutOpen: () => ipcRenderer.send('busy:about-open'),
  openGitHub: () => ipcRenderer.send('busy:open-github'),
  updatesGet: () => ipcRenderer.invoke('updates:get'),
  updatesCheck: () => ipcRenderer.invoke('updates:check'),
  updatesInstall: () => ipcRenderer.invoke('updates:install'),
  updatesSkip: () => ipcRenderer.invoke('updates:skip'),
  updateAuto: (value) => ipcRenderer.invoke('updates:set-auto', value),
  updateOpenRelease: () => ipcRenderer.send('updates:open-release'),
  onTrace: (callback) => {
    ipcRenderer.on('magpie:trace', (_event, data) => callback(data));
  },
  onConnection: (callback) => {
    ipcRenderer.on('magpie:connection', (_event, data) => callback(data));
  },
  onSettings: (callback) => {
    ipcRenderer.on('magpie:settings', (_event, data) => callback(data));
  },
  onSurfaceOpacity: (callback) => {
    ipcRenderer.on('magpie:surface-opacity', (_event, value) => callback(value));
  },
  onLayout: (callback) => {
    ipcRenderer.on('magpie:layout', (_event, data) => callback(data));
  },
  onFrame: (callback) => {
    ipcRenderer.on('magpie:frame', (_event, data) => callback(data));
  },
  onGrab: (callback) => {
    ipcRenderer.on('magpie:grab', (_event, data) => callback(data));
  },
  onUsage: (callback) => {
    ipcRenderer.on('magpie:usage', (_event, data) => callback(data));
  },
  onUsageStatus: (callback) => {
    ipcRenderer.on('magpie:usage-status', (_event, data) => callback(data));
  },
  onResize: (callback) => {
    ipcRenderer.on('magpie:resize', (_event, data) => callback(data));
  },
  onSettingsPanel: (callback) => {
    ipcRenderer.on('magpie:settings-panel', (_event, data) => callback(data));
  },
  onQuickMenu: (callback) => {
    ipcRenderer.on('magpie:quick-menu', (_event, open) => callback(open));
  },
  // A tray diagnostic asks the renderer what it can see. The reply is written
  // to the same log as the main-process snapshot, so a dead card can be told
  // apart at the DOM layer too.
  onDiagnoseRequest: (callback) => {
    ipcRenderer.on('magpie:diagnose-request', (_event, id) => callback(id));
  },
  sendDiagnoseReply: (id, report) => ipcRenderer.send('busy:diagnose-reply', id, report),
  onActionError: (callback) => {
    ipcRenderer.on('magpie:action-error', (_event, error) => callback(error));
  },
  onUpdateState: (callback) => {
    ipcRenderer.on('magpie:update-state', (_event, data) => callback(data));
  },
  onAbout: (callback) => {
    ipcRenderer.on('magpie:about', () => callback());
  },
});
