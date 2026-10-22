'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { app, BrowserWindow } = require('electron');
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
function record(event, details = {}) {
  fs.appendFileSync(config.log, `${JSON.stringify({ at: Date.now(), pid: process.pid, event, ...details })}\n`);
}
app.setPath('userData', path.join(config.root, 'profile'));
if (!config.hardware) app.disableHardwareAcceleration();
if (config.inProcessGpu) app.commandLine.appendSwitch('in-process-gpu');
if (config.disableGpu) {
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-software-rasterizer');
  app.commandLine.appendSwitch('in-process-gpu');
}
for (const event of ['before-quit', 'will-quit', 'quit']) app.on(event, () => record(event));
process.on('exit', code => record('process-exit', { code }));
app.whenReady().then(async () => {
  record('app-ready');
  if (!config.noWindow) {
    const window = new BrowserWindow({ show: false });
    for (const event of ['close', 'closed']) window.on(event, () => record(`window-${event}`));
    await window.loadURL('data:text/html,<p>Exit probe ready</p>');
  }
  await new Promise(resolve => setTimeout(resolve, 250));
  record('app-metrics', { processes: app.getAppMetrics().map(item => ({ pid: item.pid, type: item.type, serviceName: item.serviceName })) });
  if (config.noWorker) { record('quit-requested'); app.quit(); return; }
  const worker = spawn(config.workerHost || process.execPath,
    [path.join(__dirname, 'electron-exit-watch.cjs'), process.argv[2], String(process.pid)],
    { detached: config.detached !== false, stdio: 'ignore', windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  worker.on('error', cause => record('worker-error', { reason: cause.message }));
  worker.on('exit', code => record('worker-exit', { code }));
  worker.unref();
  const poll = setInterval(() => {
    if (!fs.existsSync(path.join(config.root, 'watch-ready'))) return;
    clearInterval(poll);
    record('quit-requested', { workerPid: worker.pid });
    app.quit();
  }, 10);
});
