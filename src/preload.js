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
  endLayout: () => ipcRenderer.send('busy:end-layout'),
  dragStart: () => ipcRenderer.send('busy:drag-start'),
  dragEnd: () => ipcRenderer.send('busy:drag-end'),
  resizeStart: (direction) => ipcRenderer.send('busy:resize-start', direction),
  resizeEnd: () => ipcRenderer.send('busy:resize-end'),
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
  onResize: (callback) => {
    ipcRenderer.on('magpie:resize', (_event, data) => callback(data));
  },
});
