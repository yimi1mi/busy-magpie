const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

function mainHarness({ writeError = false } = {}) {
  const root = path.resolve(__dirname, '..');
  const handlers = new Map();
  const listeners = new Map();
  const intervals = new Map();
  const files = new Map();
  let now = 0;
  let nextTimer = 0;
  let installed = 0;
  const disk = {
    mkdirSync() {},
    existsSync: file => files.has(file),
    readFileSync(file) { if (!files.has(file)) throw new Error('ENOENT'); return files.get(file); },
    writeFileSync(file, value) { if (writeError) throw new Error('disk is read-only'); files.set(file, value); },
    renameSync(from, to) { if (writeError) throw new Error('disk is read-only'); files.set(to, files.get(from)); files.delete(from); },
    rmSync(file) { files.delete(file); },
    appendFileSync() {},
  };
  const autoUpdater = new EventEmitter();
  autoUpdater.quitAndInstall = () => { installed++; };
  autoUpdater.downloadUpdate = async () => {};
  autoUpdater.checkForUpdates = async () => null;
  const app = new EventEmitter();
  Object.assign(app, { setName() {}, getVersion: () => '1.3.10', isPackaged: true,
    getPath: () => '/test', requestSingleInstanceLock: () => false, quit() {} });
  const electron = {
    app, ipcMain: { handle: (name, fn) => handlers.set(name, fn), on: (name, fn) => listeners.set(name, fn) },
    screen: { getDisplayNearestPoint: () => ({ workArea: {x:0,y:0,width:1920,height:1080} }) },
    globalShortcut: { unregisterAll() {}, register: () => true },
    Notification: { isSupported: () => false }, shell: {}, Menu: {},
  };
  const context = vm.createContext({
    require: id => id === 'electron' ? electron : id === 'electron-updater' ? {autoUpdater}
      : id === 'fs' ? disk : require(id.startsWith('.') ? path.resolve(root,'src',id) : id),
    __dirname: path.join(root,'src'), process: {platform:'win32',argv:[],env:{},on() {}},
    console, URL, AbortController, Date: class extends Date { static now() { return now; } },
    fetch: async () => ({ok:true,json:async()=>({period:'today',input:1})}),
    setTimeout: () => ++nextTimer, clearTimeout() {}, setImmediate: fn => fn(),
    setInterval: fn => {const id=++nextTimer;intervals.set(id,fn);return id;},
    clearInterval: id => intervals.delete(id),
  });
  const source = fs.readFileSync(path.join(root,'src/main.js'),'utf8');
  vm.runInContext(source + `\nsettings=defaults();settingsPath='/test/settings.json';logPath='/test/log';
    globalThis.testApi={
      settings:()=>settings,
      save:input=>ipcMain,
      usage:()=>refreshUsage(),
      schedule:()=>scheduleQuietInstall(),
      prepareUpdate:()=>{updateState.ready=true;updateState.available=true;updateState.latest='1.4.0';},
      changeMode:mode=>{settings.updateMode=mode;},
      setTrace:routes=>{lastTrace={routes};},
    };`, context);
  return {
    api: context.testApi, files,
    save: input => handlers.get('settings:save')({}, input),
    tick(ms) {now+=ms;for(const fn of [...intervals.values()])fn();},
    get installed() {return installed;},
  };
}
module.exports = {mainHarness};
