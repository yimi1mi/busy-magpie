const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

function mainHarness({ writeError = false, preview = false } = {}) {
  const root = path.resolve(__dirname, '..');
  const handlers = new Map();
  const listeners = new Map();
  const intervals = new Map();
  const files = new Map();
  let now = 0;
  let nextTimer = 0;
  let installed = 0;
  let updateChecks = 0;
  let loginChanges = 0;
  let globalShortcutReads = 0;
  const paths = new Map();
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
  autoUpdater.checkForUpdates = async () => {updateChecks++;return null;};
  const app = new EventEmitter();
  Object.assign(app, { setName() {}, getVersion: () => '1.3.10', isPackaged: true,
    getPath: () => '/test', setPath: (key,value) => paths.set(key,value), setLoginItemSettings() {loginChanges++;}, requestSingleInstanceLock: () => false, quit() {} });
  const electron = {
    app, ipcMain: { handle: (name, fn) => handlers.set(name, fn), on: (name, fn) => listeners.set(name, fn) },
    screen: { getDisplayNearestPoint: () => ({ workArea: {x:0,y:0,width:1920,height:1080} }) },
    Notification: { isSupported: () => false }, shell: {}, Menu: {},
  };
  Object.defineProperty(electron, 'globalShortcut', {
    get() { globalShortcutReads++; return {}; },
  });
  const context = vm.createContext({
    require: id => id === 'electron' ? electron : id === 'electron-updater' ? {autoUpdater}
      : id === 'fs' ? disk : require(id.startsWith('.') ? path.resolve(root,'src',id) : id),
    __dirname: path.join(root,'src'), process: {platform:'win32',argv:preview?['--preview']:[],env:preview?{BUSY_MAGPIE_PREVIEW_DIR:'/test/preview'}:{},on() {}},
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
      reloadSettings:()=>{settings=loadSettings();return settings;},
      save:input=>ipcMain,
      usage:()=>refreshUsage(),
      usageData:()=>usageData,
      usageStatus:()=>usageStatus,
      schedule:()=>scheduleQuietInstall(),
      prepareUpdate:()=>{updateState.ready=true;updateState.available=true;updateState.latest='1.4.0';},
      changeMode:mode=>{settings.updateMode=mode;},
      setTrace:routes=>{lastTrace={routes};},
      autostart:()=>applyAutostart(),
      checkUpdates:()=>checkForUpdates(true),
      installUpdate:()=>installUpdate(),
    };`, context);
  return {
    api: context.testApi, files, paths,
    ipcChannels: [...handlers.keys(), ...listeners.keys()],
    save: input => handlers.get('settings:save')({}, input),
    period: value => handlers.get('usage:set-period')({}, value),
    setFetch(fn) { context.fetch = fn; },
    tick(ms) {now+=ms;for(const fn of [...intervals.values()])fn();},
    get installed() {return installed;},
    get updateChecks() {return updateChecks;},
    get loginChanges() {return loginChanges;},
    get globalShortcutReads() {return globalShortcutReads;},
  };
}
module.exports = {mainHarness};
