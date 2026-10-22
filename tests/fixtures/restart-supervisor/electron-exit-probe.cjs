'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '../../../artifacts/restart-exit-probe', `${Date.now()}-${process.pid}`);
fs.mkdirSync(root, { recursive: true });
const electron = require('electron');
const mode = process.argv[2] || 'handle';
const config = { root, log: path.join(root, 'events.jsonl'), mode,
  workerHost: process.argv.includes('--node-worker') ? process.execPath : undefined,
  noWorker: process.argv.includes('--no-worker'), noWindow: process.argv.includes('--no-window'),
  disableGpu: process.argv.includes('--disable-gpu'),
  hardware: process.argv.includes('--hardware'), inProcessGpu: process.argv.includes('--in-process-gpu'),
  detached: !process.argv.includes('--attached') };
const filename = path.join(root, 'probe.json');
fs.writeFileSync(filename, JSON.stringify(config));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [path.join(__dirname, 'electron-exit-app.cjs'), filename],
  { cwd: root, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '';
child.stderr.on('data', bytes => { stderr += bytes; });
const timeout = setTimeout(() => {
  const requested = child.kill('SIGKILL');
  fs.appendFileSync(config.log, `${JSON.stringify({ at: Date.now(), pid: process.pid, event: 'probe-cleanup-requested', targetPid: child.pid, requested })}\n`);
}, 40000);
child.on('exit', (code, signal) => {
  clearTimeout(timeout);
  fs.appendFileSync(config.log, `${JSON.stringify({ at: Date.now(), pid: process.pid, event: 'electron-child-exit', code, signal })}\n`);
  const events = fs.readFileSync(config.log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const begin = events[0].at;
  process.stdout.write(`${root}\n${events.map(event => JSON.stringify({ ...event, ms: event.at - begin })).join('\n')}\n`);
  if (stderr) process.stderr.write(stderr);
  const quit = events.find(event => event.event === 'quit-requested');
  const end = events.find(event => event.event === 'electron-child-exit');
  if (!quit || end.at - quit.at > 3000) process.exitCode = 1;
});
