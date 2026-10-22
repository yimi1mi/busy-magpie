'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { runSupervisor } = require('../../../shell/restart-worker.cjs');
const { createStore } = require('./store.cjs');
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
runSupervisor(config, { createStore }).then(result => {
  fs.writeFileSync(path.join(config.root, 'result.json'), JSON.stringify(result));
}).catch(error => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
