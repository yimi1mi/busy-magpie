'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {MAX_FILES, MAX_UNCOMPRESSED_BYTES, createManifest, createPackage, isShellOwnedPath, sha256, validatePayloadPath} = require('../shell/package.cjs');

function collectFiles(sourceRoot) {
  const files = new Map();
  let totalBytes = 0;
  function walk(absolute, relative) {
    const stats = fs.lstatSync(absolute);
    if (stats.isSymbolicLink()) throw new Error('Payload sources cannot contain symbolic links: ' + relative);
    if (stats.isDirectory()) {
      for (const name of fs.readdirSync(absolute).sort()) walk(path.join(absolute, name), relative + '/' + name);
    } else if (stats.isFile()) {
      if (isShellOwnedPath(relative)) return;
      validatePayloadPath(relative);
      totalBytes += stats.size;
      if (files.size >= MAX_FILES || totalBytes > MAX_UNCOMPRESSED_BYTES) throw new Error('Payload sources exceed the file count or size limit.');
      files.set(relative, fs.readFileSync(absolute));
    } else {
      throw new Error('Payload sources must be regular files: ' + relative);
    }
  }
  for (const folder of ['src', 'web', 'assets']) walk(path.join(sourceRoot, folder), folder);
  return files;
}

function atomicWrite(filePath, bytes) {
  const temporary = filePath + '.tmp-' + crypto.randomBytes(8).toString('hex');
  try {
    fs.writeFileSync(temporary, bytes, {flag: 'wx'});
    fs.renameSync(temporary, filePath);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function buildPayload({sourceRoot = path.resolve(__dirname, '..'), outputDir, keyFile, keyId, version, minShellVersion = '1.4.0', shellApi = 1, notes = '', baseUrl}) {
  if (!outputDir || !keyFile || !keyId) throw new Error('Signed payload builds require --output DIR --key-file PEM --key-id ID. No default signing key is generated.');
  const resolvedSource = path.resolve(sourceRoot);
  const resolvedOutput = path.resolve(outputDir);
  const resolvedKey = path.resolve(keyFile);
  for (const folder of ['src', 'web', 'assets']) {
    const relativeKey = path.relative(path.join(resolvedSource, folder), resolvedKey);
    if (relativeKey === '' || (relativeKey !== '..' && !relativeKey.startsWith('..' + path.sep) && !path.isAbsolute(relativeKey))) {
      throw new Error('The signing key must be kept outside src/, web/ and assets/ so it cannot enter the payload.');
    }
  }
  if (!version) version = JSON.parse(fs.readFileSync(path.join(resolvedSource, 'package.json'), 'utf8')).version;
  const privateKey = fs.readFileSync(resolvedKey, 'utf8');
  const files = collectFiles(resolvedSource);
  const manifest = createManifest({version, minShellVersion, shellApi, keyId, files, notes});
  const bytes = createPackage({manifest, files, privateKey});
  const filename = version + '.bmpkg';
  let packageUrl = filename;
  if (baseUrl) {
    const base = new URL(baseUrl.endsWith('/') ? baseUrl : baseUrl + '/');
    if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
      throw new Error('--base-url must be an HTTP(S) directory URL without credentials, query or fragment.');
    }
    packageUrl = new URL(filename, base).href;
  }
  const feed = {format: 1, version, minShellVersion, shellApi, packageUrl, sha256: sha256(bytes), size: bytes.length, notes};
  fs.mkdirSync(resolvedOutput, {recursive: true});
  const packagePath = path.join(resolvedOutput, filename);
  const feedPath = path.join(resolvedOutput, 'business-latest.json');
  atomicWrite(packagePath, bytes);
  atomicWrite(feedPath, JSON.stringify(feed, null, 2) + '\n');
  return {packagePath, feedPath, feed, manifest};
}

function parseArguments(args) {
  const options = {};
  const names = {'--output': 'outputDir', '--key-file': 'keyFile', '--key-id': 'keyId', '--version': 'version', '--min-shell-version': 'minShellVersion', '--notes': 'notes', '--base-url': 'baseUrl'};
  for (let i = 0; i < args.length; i++) {
    const name = names[args[i]];
    if (!name || Object.hasOwn(options, name) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Unknown, duplicate or incomplete build option: ' + args[i]);
    options[name] = args[++i];
  }
  return options;
}

if (require.main === module) {
  try {
    const result = buildPayload(parseArguments(process.argv.slice(2)));
    process.stdout.write('Signed payload: ' + result.packagePath + '\nRelease feed: ' + result.feedPath + '\n');
  } catch (error) {
    process.stderr.write('Payload build failed: ' + error.message + '\n');
    process.exitCode = 1;
  }
}

module.exports = {buildPayload, collectFiles, parseArguments};
