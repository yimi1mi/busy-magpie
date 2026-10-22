'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {failure, verifyPackage, MAX_COMPRESSED_BYTES} = require('./package.cjs');

const PACKAGE_FILE = '.package.bmpkg';

function lstatIfPresent(filePath) {
  try { return fs.lstatSync(filePath); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function checkedDirectory(directory, create = false) {
  const absolute = path.resolve(directory);
  const parsed = path.parse(absolute);
  let cursor = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    let stats = lstatIfPresent(cursor);
    if (!stats && create) {
      try { fs.mkdirSync(cursor); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      stats = fs.lstatSync(cursor);
    }
    if (!stats || stats.isSymbolicLink() || !stats.isDirectory()) {
      throw failure('STORE_TAMPERED', 'Payload store directories must be real directories, without symbolic links.');
    }
  }
  return absolute;
}

function descriptorFor(verified) {
  return {id: verified.manifest.version + '-' + verified.manifestHash.slice(0, 16), version: verified.manifest.version, manifestHash: verified.manifestHash};
}

function checkDescriptor(descriptor) {
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)
      || Object.keys(descriptor).length !== 3 || !['id', 'version', 'manifestHash'].every(key => Object.hasOwn(descriptor, key))
      || typeof descriptor.version !== 'string' || !/^[0-9A-Za-z.+-]{1,128}$/.test(descriptor.version)
      || typeof descriptor.manifestHash !== 'string' || !/^[a-f0-9]{64}$/.test(descriptor.manifestHash)
      || descriptor.id !== descriptor.version + '-' + descriptor.manifestHash.slice(0, 16)) {
    throw failure('INVALID_DESCRIPTOR', 'Payload descriptor must contain only its version, manifest hash and derived ID.');
  }
}

function verifyExtracted(directory, verified) {
  checkedDirectory(directory);
  const expectedDirectories = new Set();
  for (const name of verified.files.keys()) {
    const segments = name.split('/');
    while (segments.length > 1) { segments.pop(); expectedDirectories.add(segments.join('/')); }
  }
  const actualFiles = new Set();
  function walk(current, relative = '') {
    for (const name of fs.readdirSync(current)) {
      const child = path.join(current, name);
      const relativePath = relative ? relative + '/' + name : name;
      const stats = fs.lstatSync(child);
      if (stats.isSymbolicLink()) throw failure('STORE_TAMPERED', 'Payload version contains a symbolic link.');
      if (stats.isDirectory()) {
        if (!expectedDirectories.has(relativePath)) throw failure('STORE_TAMPERED', 'Payload version contains an unexpected directory.');
        walk(child, relativePath);
      } else if (stats.isFile()) {
        if (relativePath === PACKAGE_FILE) continue;
        const expected = verified.files.get(relativePath);
        if (!expected || stats.size !== expected.length || !fs.readFileSync(child).equals(expected)) {
          throw failure('STORE_TAMPERED', 'Payload version file differs from its signed package: ' + relativePath + '.');
        }
        actualFiles.add(relativePath);
      } else {
        throw failure('STORE_TAMPERED', 'Payload version contains a non-regular file.');
      }
    }
  }
  walk(directory);
  if (actualFiles.size !== verified.files.size) throw failure('STORE_TAMPERED', 'Payload version is missing signed files.');
}

function createStore({root, trustedKeys, shellVersion, shellApi = 1}) {
  if (typeof root !== 'string' || !root) throw failure('INVALID_DESCRIPTOR', 'Payload store root is required.');
  const storeRoot = path.resolve(root);
  const versionsRoot = path.join(storeRoot, 'versions');
  const verification = {trustedKeys, shellVersion, shellApi};

  function verify(descriptor) {
    checkDescriptor(descriptor);
    const directory = path.join(versionsRoot, descriptor.id);
    checkedDirectory(directory);
    const archivePath = path.join(directory, PACKAGE_FILE);
    const archiveStats = lstatIfPresent(archivePath);
    if (!archiveStats || archiveStats.isSymbolicLink() || !archiveStats.isFile() || archiveStats.size > MAX_COMPRESSED_BYTES) {
      throw failure('STORE_TAMPERED', 'Payload version is missing its original signed package.');
    }
    const verified = verifyPackage(fs.readFileSync(archivePath), verification);
    const actual = descriptorFor(verified);
    if (actual.id !== descriptor.id || actual.version !== descriptor.version || actual.manifestHash !== descriptor.manifestHash) {
      throw failure('STORE_TAMPERED', 'Payload descriptor differs from the signed package.');
    }
    verifyExtracted(directory, verified);
    return {...actual, root: directory, manifest: verified.manifest};
  }

  function stage(buffer) {
    const verified = verifyPackage(buffer, verification);
    const descriptor = descriptorFor(verified);
    checkedDirectory(versionsRoot, true);
    const destination = path.join(versionsRoot, descriptor.id);
    if (lstatIfPresent(destination)) { verify(descriptor); return descriptor; }
    const temporary = fs.mkdtempSync(path.join(versionsRoot, '.stage-'));
    try {
      for (const [relativePath, bytes] of verified.files) {
        const target = path.join(temporary, ...relativePath.split('/'));
        checkedDirectory(path.dirname(target), true);
        fs.writeFileSync(target, bytes, {flag: 'wx', mode: 0o600});
      }
      fs.writeFileSync(path.join(temporary, PACKAGE_FILE), buffer, {flag: 'wx', mode: 0o600});
      verifyExtracted(temporary, verified);
      checkedDirectory(versionsRoot);
      try {
        fs.renameSync(temporary, destination);
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code) || !lstatIfPresent(destination)) throw error;
        verify(descriptor);
      }
      return descriptor;
    } finally {
      if (lstatIfPresent(temporary)) fs.rmSync(temporary, {recursive: true, force: true});
    }
  }

  return {stage, verify};
}

module.exports = {createStore};
