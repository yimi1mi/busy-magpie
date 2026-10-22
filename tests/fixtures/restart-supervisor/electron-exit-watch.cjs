'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { watchProcess } = require('../../../shell/restart-worker.cjs');
const { alive } = require('../../../shell/journal.cjs');
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const pid = Number(process.argv[3]);
function record(event, details = {}) {
  fs.appendFileSync(config.log, `${JSON.stringify({ at: Date.now(), pid: process.pid, event, ...details })}\n`);
}
const watch = config.mode === 'handle' ? watchProcess(pid) : null;
record('worker-ready', { parentPid: pid, mechanism: watch?.mechanism || config.mode });
fs.writeFileSync(path.join(config.root, 'watch-ready'), 'ready');
const begin = Date.now();
let falsePidLogged = false;
const timer = setInterval(() => {
  if (!alive(pid) && !falsePidLogged) { record('pid-probe-false'); falsePidLogged = true; }
  const exited = watch ? watch.exited() : config.mode === 'pid' ? !alive(pid) : false;
  if (exited || Date.now() - begin > 3500) {
    clearInterval(timer);
    record(exited ? 'parent-signaled' : 'watch-timeout');
    watch?.close();
    record('worker-finished');
  }
}, 20);
