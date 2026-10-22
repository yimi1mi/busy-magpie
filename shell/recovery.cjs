'use strict';

const fs = require('node:fs');
const path = require('node:path');
function samePath(left, right) {
  const a = path.resolve(left), b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
function realPath(filename, { optional = false, directory = false } = {}) {
  const absolute = path.resolve(filename);
  const parsed = path.parse(absolute);
  let cursor = parsed.root;
  const segments = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (let index = 0; index < segments.length; index++) {
    cursor = path.join(cursor, segments[index]);
    let stat;
    try { stat = fs.lstatSync(cursor); }
    catch (error) { if (optional && error.code === 'ENOENT' && index === segments.length - 1) return; throw error; }
    if (stat.isSymbolicLink() || (index < segments.length - 1 || directory ? !stat.isDirectory() : !stat.isFile())) {
      throw new Error('Settings recovery paths must be ordinary local files and directories');
    }
  }
}
function validateRecovery(config) {
  if (!config || !path.isAbsolute(config.root || '') || !/^[a-f0-9]{48}$/.test(config.token || '')) {
    throw new Error('Invalid local recovery transaction');
  }
  const backup = config.settingsBackup;
  if (!backup || typeof backup.existed !== 'boolean' || !path.isAbsolute(backup.path || '') || !path.isAbsolute(backup.target || '')
    || !samePath(backup.path, path.join(config.root, 'transactions', config.token, 'settings.json'))
    || !samePath(backup.target, path.join(path.dirname(config.root), 'settings.json'))) {
    throw new Error('Invalid settings recovery record');
  }
  realPath(path.dirname(backup.path), { directory: true });
  realPath(backup.path, { optional: !backup.existed });
  realPath(backup.target, { optional: true });
  realPath(path.join(path.dirname(backup.path), 'failed-settings.json'), { optional: true });
  return backup;
}

module.exports = { validateRecovery };
