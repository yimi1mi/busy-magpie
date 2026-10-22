'use strict';
const fs = require('node:fs');
const path = require('node:path');
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const { createJournal, writeJson } = require('../../../shell/journal.cjs');
const { createStore } = require('./store.cjs');
const token = process.argv.find(arg => arg.startsWith('--business-update-token='))?.split('=')[1];
function record(event, details = {}) {
  fs.appendFileSync(path.join(config.root, 'events.jsonl'), `${JSON.stringify({ event, pid: process.pid, ...details })}\n`);
}
if (process.argv.includes('--hold-old')) {
  record('old');
} else {
  const journal = createJournal({ root: config.root, builtin: config.builtin, store: createStore(config) });
  const selected = journal.select(token);
  record(token ? 'candidate' : 'fallback', { version: selected.version, token,
    runAsNode: process.env.ELECTRON_RUN_AS_NODE || null,
    settings: config.settingsBackup && fs.existsSync(config.settingsBackup.target)
      ? fs.readFileSync(config.settingsBackup.target, 'utf8') : null });
  if (token) {
    if (config.dirtySettings) fs.writeFileSync(config.settingsBackup.target, '{"schema":99}');
    if (config.removeBackup) fs.unlinkSync(config.settingsBackup.path);
    if (config.behavior === 'crash') process.exit(17);
    if (config.behavior === 'bad-health') {
      fs.writeFileSync(path.join(config.root, `health-${token}.json`), JSON.stringify({ token, pid: process.pid + 999999, at: Date.now() }));
    } else if (config.behavior !== 'timeout') {
      journal.ready(token, process.pid);
      if (config.heartbeat) setInterval(() => {
        if (journal.read().pending?.token === token) journal.ready(token, process.pid);
      }, 400);
      if (config.behavior === 'ready-crash') setTimeout(() => process.exit(18), 30);
    }
  } else if (!config.fallbackTimeout) {
    writeJson(path.join(config.root, 'runtime-ready.json'), { pid: process.pid, version: selected.version, at: Date.now() });
  }
}
setTimeout(() => process.exit(0), 30000);
