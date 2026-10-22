'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createStore } = require('./store.cjs');
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (config.missFirstCandidateProbe) {
  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  const originalKill = process.kill;
  let candidate;
  let missed = false;
  childProcess.spawn = (...args) => {
    const child = originalSpawn(...args);
    if (args[1]?.some(arg => arg.startsWith('--business-update-token='))) candidate = child;
    return child;
  };
  process.kill = (pid, signal) => {
    if (!missed && candidate?.pid === pid && signal === 0) {
      let entered = false;
      try {
        entered = fs.readFileSync(path.join(config.root, 'events.jsonl'), 'utf8').split('\n').filter(Boolean)
          .map(line => JSON.parse(line)).some(event => event.pid === pid && event.event === 'fixture-start');
      } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
      if (!entered) {
        missed = true;
        fs.appendFileSync(path.join(config.root, 'events.jsonl'), `${JSON.stringify({ event: 'pid-probe-miss', pid })}\n`);
        throw Object.assign(new Error('Injected first PID lookup miss before candidate bootstrap'), { code: 'ESRCH' });
      }
    }
    return originalKill(pid, signal);
  };
}
const { runSupervisor } = require('../../../shell/restart-worker.cjs');
runSupervisor(config, { createStore }).then(result => {
  fs.writeFileSync(path.join(config.root, 'result.json'), JSON.stringify(result));
}).catch(error => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
