'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const directory = path.join(__dirname, '..', 'tests');
const files = fs.readdirSync(directory).filter(name => /\.test\.(?:cjs|mjs)$/.test(name))
  .sort().map(name => path.join(directory, name));
const result = spawnSync(process.execPath, ['--test', ...files], {stdio:'inherit'});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
