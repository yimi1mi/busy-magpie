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

contextBridge.exposeInMainWorld('settingsApi', {
  icons: { magpie: readAsset('magpie-path.txt') },
  get: () => ipcRenderer.invoke('settings:get'),
  save: (data) => ipcRenderer.invoke('settings:save', data),
  openFile: () => ipcRenderer.send('settings:open-file'),
  close: () => ipcRenderer.send('settings:close'),
});
