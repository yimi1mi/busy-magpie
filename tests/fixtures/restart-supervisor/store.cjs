'use strict';
const fs = require('node:fs');
const path = require('node:path');
function createStore({ root }) {
  return { verify(value) {
    const directory = path.join(root, 'versions', value.id);
    const stored = JSON.parse(fs.readFileSync(path.join(directory, 'valid.json'), 'utf8'));
    if (stored.manifestHash !== value.manifestHash || stored.version !== value.version) throw new Error('bad package');
    return { ...value, root: directory, manifest: { version: value.version } };
  } };
}
module.exports = { createStore };
