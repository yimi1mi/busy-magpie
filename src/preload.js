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
  toggleMenu: () => ipcRenderer.send('busy:menu-toggle'),
  closeMenu: () => ipcRenderer.send('busy:menu-close'),
  openHistory: () => ipcRenderer.send('busy:history-open'),
  toggleCompact: () => ipcRenderer.send('busy:compact-toggle'),
  menuAction: (action) => ipcRenderer.send('busy:menu-action', action),
  copySummary: (text) => ipcRenderer.invoke('busy:copy-summary', text),
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsSave: (data) => ipcRenderer.invoke('settings:save', data),
  testGateway: (raw) => ipcRenderer.invoke('gateway:test', raw),
  captureHotkey: (on) => ipcRenderer.send('hotkey:capture', on),
  testHotkey: (value) => ipcRenderer.invoke('hotkey:test', value),
  resetPlacement: () => ipcRenderer.invoke('window:reset'),
  previewOpacity: (value) => ipcRenderer.send('settings:opacity', value),
  settingsOpenFile: () => ipcRenderer.send('settings:open-file'),
  settingsClose: () => ipcRenderer.send('settings:close'),
  firstRunDismiss: () => ipcRenderer.send('busy:first-run-dismiss'),
  openInstallDir: () => ipcRenderer.send('busy:open-install-dir'),
  aboutOpen: () => ipcRenderer.send('busy:about-open'),
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
  onActionError: (callback) => {
    ipcRenderer.on('magpie:action-error', (_event, error) => callback(error));
  },
  onHotkeyCapture: (callback) => {
    ipcRenderer.on('magpie:hotkey-capture', (_event, on) => callback(on));
  },
  onFirstRun: (callback) => {
    ipcRenderer.on('magpie:first-run', (_event, data) => callback(data));
  },
  onUpdateState: (callback) => {
    ipcRenderer.on('magpie:update-state', (_event, data) => callback(data));
  },
  onAbout: (callback) => {
    ipcRenderer.on('magpie:about', () => callback());
  },
});
