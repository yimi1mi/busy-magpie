'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const yaml = require('js-yaml');

function fail(message) { throw new Error(message); }
function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exactKeys(value, keys) { return plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)); }

function validateIdentity(version, sourceSha) {
  if (typeof version !== 'string' || version.length > 96 || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version)) fail('A valid package version is required.');
  if (typeof sourceSha !== 'string' || !/^[a-f0-9]{40}$/.test(sourceSha)) fail('sourceSha must be the full lowercase Git commit SHA.');
}

function layout(platform, version) {
  if (!['windows', 'macos'].includes(platform)) fail('platform must be windows or macos.');
  const prefix = 'Busy.Magpie-' + version;
  const payloads = platform === 'windows' ? [prefix + '-win-x64.exe']
    : ['x64', 'arm64'].flatMap(arch => ['dmg', 'zip'].map(extension => prefix + '-mac-' + arch + '.' + extension));
  const feed = platform === 'windows' ? 'latest.yml' : 'latest-mac.yml';
  const checksum = platform === 'windows' ? payloads[0] + '.sha256' : null;
  const required = [...payloads, feed, ...(platform === 'windows' ? [payloads[0] + '.blockmap', checksum] : [])];
  const optional = platform === 'macos' ? payloads.map(name => name + '.blockmap') : [];
  return {payloads, feed, checksum, required, optional, allowed: new Set([...required, ...optional])};
}

function safeName(name) {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[\\/:\x00-\x1f\x7f]/.test(name) || /[. ]$/.test(name)) fail('Asset names must be plain relative basenames.');
  return name;
}

function checkedDirectory(directory, create = false) {
  if (typeof directory !== 'string' || !directory) fail('A directory is required.');
  const absolute = path.resolve(directory);
  const parsed = path.parse(absolute);
  let cursor = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    let stat;
    try { stat = fs.lstatSync(cursor); }
    catch (error) {
      if (!create || error.code !== 'ENOENT') throw error;
      fs.mkdirSync(cursor);
      stat = fs.lstatSync(cursor);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail('Artifact directories cannot contain symbolic links or non-directory ancestors.');
  }
  return absolute;
}

function regularFile(directory, name) {
  const filename = path.join(directory, safeName(name));
  const stat = fs.lstatSync(filename);
  if (stat.isSymbolicLink() || !stat.isFile()) fail('Release assets must be ordinary files: ' + name);
  return {filename, stat};
}

function inspectFile(directory, name) {
  const {filename, stat} = regularFile(directory, name);
  if (stat.size <= 0) fail('Release assets must not be empty: ' + name);
  const sha256 = crypto.createHash('sha256');
  const sha512 = crypto.createHash('sha512');
  const block = Buffer.allocUnsafe(1024 * 1024);
  const fd = fs.openSync(filename, 'r');
  let size = 0;
  try {
    for (;;) {
      const count = fs.readSync(fd, block, 0, block.length, null);
      if (!count) break;
      size += count;
      sha256.update(block.subarray(0, count));
      sha512.update(block.subarray(0, count));
    }
  } finally { fs.closeSync(fd); }
  if (size !== stat.size) fail('Asset size changed during verification: ' + name);
  return {name, size, sha256: sha256.digest('hex'), sha512: sha512.digest('base64')};
}

function readMetadata(directory, name) {
  const {filename, stat} = regularFile(directory, name);
  if (stat.size > 1024 * 1024) fail('Release metadata exceeds 1 MiB: ' + name);
  return fs.readFileSync(filename, 'utf8');
}

function verifyFeed(directory, version, spec, files) {
  const feed = yaml.load(readMetadata(directory, spec.feed), {schema: yaml.JSON_SCHEMA});
  if (!plain(feed) || feed.version !== version || !Array.isArray(feed.files) || !feed.files.length || feed.files.length > spec.payloads.length) fail('Update feed has an invalid version or file list.');
  const seen = new Set();
  for (const entry of feed.files) {
    if (!plain(entry)) fail('Update feed file entries must be objects.');
    const name = safeName(entry.url);
    if (!spec.payloads.includes(name) || seen.has(name.toLowerCase())) fail('Update feed references an unexpected or duplicate asset: ' + name);
    seen.add(name.toLowerCase());
    const actual = files.get(name);
    if (!Number.isSafeInteger(entry.size) || entry.size !== actual.size || typeof entry.sha512 !== 'string' || entry.sha512 !== actual.sha512) fail('Update feed size or SHA-512 does not match ' + name);
  }
  const primary = safeName(feed.path);
  if (!spec.payloads.includes(primary) || !seen.has(primary.toLowerCase())) fail('Update feed path must refer to one of its files.');
  const actual = files.get(primary);
  if (typeof feed.sha512 !== 'string' || feed.sha512 !== actual.sha512 || (Object.hasOwn(feed, 'size') && feed.size !== actual.size)) fail('Update feed primary path size or SHA-512 does not match.');
}

function writeFile(directory, name, content) {
  const target = path.join(directory, safeName(name));
  try {
    const existing = fs.lstatSync(target);
    if (existing.isSymbolicLink() || !existing.isFile()) fail('Refusing to replace a linked or non-file artifact: ' + name);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = target + '.tmp-' + crypto.randomBytes(8).toString('hex');
  try {
    fs.writeFileSync(temporary, content, {flag: 'wx'});
    fs.renameSync(temporary, target);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function publicRecord(record) { return {name: record.name, size: record.size, sha256: record.sha256}; }

function prepare({directory, platform, version, sourceSha}) {
  validateIdentity(version, sourceSha);
  const spec = layout(platform, version);
  const root = checkedDirectory(directory);
  const names = new Set(fs.readdirSync(root));
  for (const name of names) {
    if (name.endsWith('.blockmap') && !spec.payloads.includes(name.slice(0, -'.blockmap'.length))) fail('Block map has no matching platform asset: ' + name);
  }
  const selected = spec.required.filter(name => name !== spec.checksum).concat(spec.optional.filter(name => names.has(name))).sort();
  const files = new Map(selected.map(name => [name, inspectFile(root, name)]));
  verifyFeed(root, version, spec, files);
  if (spec.checksum) {
    const installer = files.get(spec.payloads[0]);
    writeFile(root, spec.checksum, installer.sha256 + '  ' + installer.name + '\n');
    files.set(spec.checksum, inspectFile(root, spec.checksum));
  }
  const manifest = {schema: 1, version, sourceSha, platform, assets: [...files.values()].map(publicRecord).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)};
  const manifestName = 'release-manifest-' + platform + '.json';
  writeFile(root, manifestName, JSON.stringify(manifest, null, 2) + '\n');
  return {manifest, manifestPath: path.join(root, manifestName)};
}

function discoverManifests(directories) {
  const found = [];
  function visit(directory) {
    for (const name of fs.readdirSync(directory)) {
      const filename = path.join(directory, name);
      const stat = fs.lstatSync(filename);
      if (stat.isSymbolicLink()) fail('Downloaded artifacts cannot contain symbolic links.');
      if (stat.isDirectory()) visit(filename);
      else if (/^release-manifest-.*\.json$/.test(name)) {
        if (!stat.isFile() || !/^release-manifest-(windows|macos)\.json$/.test(name)) fail('Unexpected platform manifest: ' + name);
        found.push({directory, name});
      }
    }
  }
  for (const directory of directories) visit(checkedDirectory(directory));
  if (found.length !== 2) fail('Exactly one Windows and one macOS manifest are required.');
  return found;
}

function verifyManifest(location, version, sourceSha) {
  const manifest = JSON.parse(readMetadata(location.directory, location.name));
  if (!exactKeys(manifest, ['schema', 'version', 'sourceSha', 'platform', 'assets']) || manifest.schema !== 1
      || manifest.version !== version || manifest.sourceSha !== sourceSha || !Array.isArray(manifest.assets)
      || location.name !== 'release-manifest-' + manifest.platform + '.json') fail('Platform manifest version, source commit or schema does not match.');
  const spec = layout(manifest.platform, version);
  if (manifest.assets.length > spec.allowed.size) fail('Manifest contains too many public assets.');
  const seen = new Set();
  const files = new Map();
  for (const record of manifest.assets) {
    if (!exactKeys(record, ['name', 'size', 'sha256'])) fail('Malformed release asset record.');
    safeName(record.name);
    if (!spec.allowed.has(record.name) || seen.has(record.name.toLowerCase())) fail('Manifest contains an unexpected or duplicate asset: ' + record.name);
    seen.add(record.name.toLowerCase());
    const actual = inspectFile(location.directory, record.name);
    if (!Number.isSafeInteger(record.size) || record.size !== actual.size || !/^[a-f0-9]{64}$/.test(record.sha256) || record.sha256 !== actual.sha256) fail('Manifest size or SHA-256 does not match ' + record.name);
    files.set(record.name, actual);
  }
  for (const required of spec.required) if (!files.has(required)) fail('Manifest is missing required asset: ' + required);
  verifyFeed(location.directory, version, spec, files);
  if (spec.checksum) {
    const installer = files.get(spec.payloads[0]);
    if (readMetadata(location.directory, spec.checksum) !== installer.sha256 + '  ' + installer.name + '\n') fail('Windows installer checksum file is inconsistent.');
  }
  return {manifest, files};
}

function overlaps(left, right) {
  const relative = path.relative(left, right);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function collect({directories, outputDirectory, version, sourceSha}) {
  validateIdentity(version, sourceSha);
  if (!Array.isArray(directories) || !directories.length || directories.some(value => typeof value !== 'string' || !value) || typeof outputDirectory !== 'string' || !outputDirectory) fail('Input directories and an output directory are required.');
  const output = path.resolve(outputDirectory);
  for (const input of directories.map(value => path.resolve(value))) if (overlaps(input, output) || overlaps(output, input)) fail('Release output must not overlap downloaded artifact directories.');
  const locations = discoverManifests(directories);
  const platforms = new Set();
  const selected = new Map();
  for (const location of locations) {
    const verified = verifyManifest(location, version, sourceSha);
    if (platforms.has(verified.manifest.platform)) fail('Duplicate platform manifest.');
    platforms.add(verified.manifest.platform);
    for (const [name, record] of verified.files) {
      if (selected.has(name.toLowerCase())) fail('Duplicate public filename across platform manifests.');
      selected.set(name.toLowerCase(), {directory: location.directory, ...record});
    }
  }
  if (!platforms.has('windows') || !platforms.has('macos')) fail('Both platform manifests are required.');
  const outputExists = fs.existsSync(output);
  if (outputExists && fs.readdirSync(checkedDirectory(output)).length) fail('Release output directory must be empty.');
  checkedDirectory(output, true);
  const assets = [...selected.values()].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0).map(record => {
    fs.copyFileSync(path.join(record.directory, record.name), path.join(output, record.name), fs.constants.COPYFILE_EXCL);
    const copied = inspectFile(output, record.name);
    if (copied.sha256 !== record.sha256 || copied.size !== record.size) fail('Copied asset differs from the verified source: ' + record.name);
    return publicRecord(copied);
  });
  writeFile(output, 'SHA256SUMS', assets.map(asset => asset.sha256 + '  ' + asset.name).join('\n') + '\n');
  assets.push(publicRecord(inspectFile(output, 'SHA256SUMS')));
  const manifest = {schema: 1, version, sourceSha, platforms: ['windows', 'macos'], assets};
  writeFile(output, 'release-manifest.json', JSON.stringify(manifest, null, 2) + '\n');
  return {manifest, manifestPath: path.join(output, 'release-manifest.json'), directory: output};
}

function runCli(args) {
  const command = args.shift();
  if (!['prepare', 'collect'].includes(command)) fail('Use prepare or collect.');
  const options = {directories: []};
  const names = {'--directory': 'directory', '--platform': 'platform', '--version': 'version', '--source-sha': 'sourceSha', '--output': 'outputDirectory'};
  for (let index = 0; index < args.length; index++) {
    const key = names[args[index]];
    const value = args[index + 1];
    if (!key || !value || value.startsWith('--')) fail('Unknown or incomplete release-artifacts option: ' + args[index]);
    if (key === 'directory') options.directories.push(value);
    else {
      if (Object.hasOwn(options, key)) fail('Duplicate option: ' + args[index]);
      options[key] = value;
    }
    index++;
  }
  const version = options.version || JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8')).version;
  const sourceSha = options.sourceSha || process.env.GITHUB_SHA;
  if (command === 'prepare') {
    if (options.directories.length !== 1 || options.outputDirectory) fail('prepare requires one --directory and no --output.');
    return prepare({directory: options.directories[0], platform: options.platform, version, sourceSha});
  }
  if (options.platform) fail('collect reads platforms from their manifests.');
  return collect({directories: options.directories, outputDirectory: options.outputDirectory, version, sourceSha});
}

if (require.main === module) {
  try {
    const result = runCli(process.argv.slice(2));
    process.stdout.write(JSON.stringify({manifestPath: result.manifestPath, publicAssets: result.manifest.assets.map(asset => asset.name)}, null, 2) + '\n');
  } catch (error) {
    process.stderr.write('Release artifact validation failed: ' + error.message + '\n');
    process.exitCode = 1;
  }
}

module.exports = {prepare, collect};
