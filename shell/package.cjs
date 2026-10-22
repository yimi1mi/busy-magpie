'use strict';

const crypto = require('node:crypto');
const zlib = require('node:zlib');
const {TextDecoder} = require('node:util');

const MAX_COMPRESSED_BYTES = 32 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 512;
const REQUIRED_FILES = ['src/main.js', 'src/preload.js', 'web/index.html'];
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function failure(code, message) {
  return Object.assign(new Error(message), {code});
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function exactKeys(value, required, optional = []) {
  return plainObject(value) && required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}

function canonicalManifest(value) {
  const ancestors = new Set();
  function encode(item) {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== 'object' || ancestors.has(item)) throw failure('INVALID_PACKAGE', 'Manifest contains a non-JSON value.');
    ancestors.add(item);
    let encoded;
    if (Array.isArray(item)) {
      for (let i = 0; i < item.length; i++) {
        if (!Object.hasOwn(item, i)) throw failure('INVALID_PACKAGE', 'Manifest contains a sparse array.');
      }
      encoded = '[' + item.map(encode).join(',') + ']';
    } else if (plainObject(item)) {
      encoded = '{' + Object.keys(item).sort().map(key => JSON.stringify(key) + ':' + encode(item[key])).join(',') + '}';
    } else {
      throw failure('INVALID_PACKAGE', 'Manifest contains a non-JSON object.');
    }
    ancestors.delete(item);
    return encoded;
  }
  return encode(value);
}

function parseVersion(value) {
  const match = typeof value === 'string' && value.length <= 128 && SEMVER.exec(value);
  if (!match || (match[4] && match[4].split('.').some(part => /^\d+$/.test(part) && part.length > 1 && part[0] === '0'))) {
    throw failure('INVALID_PACKAGE', 'Expected a semantic version without a v prefix.');
  }
  return {core: match.slice(1, 4).map(BigInt), prerelease: match[4]?.split('.') || []};
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i] ? 1 : -1;
  }
  if (!a.prerelease.length || !b.prerelease.length) return Number(!a.prerelease.length) - Number(!b.prerelease.length);
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    if (a.prerelease[i] === undefined) return -1;
    if (b.prerelease[i] === undefined) return 1;
    const x = a.prerelease[i];
    const y = b.prerelease[i];
    if (x === y) continue;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (nx !== ny) return nx ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

function isShellOwnedPath(filePath) {
  const lower = filePath.toLowerCase();
  return lower === 'src/windows-blur.cjs';
}

function validatePayloadPath(filePath) {
  if (typeof filePath !== 'string' || filePath.length > 240 || !/^(src|web|assets)\/.+/.test(filePath)
      || /[\\:\x00-\x1f\x7f<>"|?*]/.test(filePath) || filePath !== filePath.normalize('NFC')) {
    throw failure('UNSAFE_PATH', 'Payload paths must be relative, normalized src/, web/ or assets/ paths.');
  }
  for (const segment of filePath.split('/')) {
    if (!segment || segment === '.' || segment === '..' || /[. ]$/.test(segment)
        || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(segment)) {
      throw failure('UNSAFE_PATH', 'Payload path contains an unsafe or reserved segment.');
    }
  }
  if (isShellOwnedPath(filePath)) throw failure('UNSAFE_PATH', 'Native host modules belong to the installed shell.');
  return filePath;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function validateManifest(manifest) {
  if (!exactKeys(manifest, ['format', 'version', 'minShellVersion', 'shellApi', 'keyId', 'files'], ['notes'])
      || manifest.format !== 1 || !Number.isSafeInteger(manifest.shellApi) || manifest.shellApi < 1
      || typeof manifest.keyId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(manifest.keyId)
      || (Object.hasOwn(manifest, 'notes') && typeof manifest.notes !== 'string')
      || !Array.isArray(manifest.files) || manifest.files.length < REQUIRED_FILES.length || manifest.files.length > MAX_FILES) {
    throw failure('INVALID_PACKAGE', 'Malformed payload manifest.');
  }
  parseVersion(manifest.version);
  parseVersion(manifest.minShellVersion);
  const paths = new Set();
  const spellings = new Map();
  let totalBytes = 0;
  for (const file of manifest.files) {
    if (!exactKeys(file, ['path', 'size', 'sha256']) || !Number.isSafeInteger(file.size) || file.size < 0
        || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw failure('INVALID_PACKAGE', 'Malformed manifest file entry.');
    }
    validatePayloadPath(file.path);
    const folded = file.path.toLowerCase();
    if (paths.has(folded)) throw failure('UNSAFE_PATH', 'Payload contains duplicate or case-colliding paths.');
    paths.add(folded);
    const segments = file.path.split('/');
    for (let i = 1; i <= segments.length; i++) {
      const prefix = segments.slice(0, i).join('/');
      const existing = spellings.get(prefix.toLowerCase());
      if (existing !== undefined && existing !== prefix) throw failure('UNSAFE_PATH', 'Payload contains case-colliding directory paths.');
      spellings.set(prefix.toLowerCase(), prefix);
    }
    totalBytes += file.size;
    if (totalBytes > MAX_UNCOMPRESSED_BYTES) throw failure('INVALID_PACKAGE', 'Payload file bytes exceed the size limit.');
  }
  for (const name of paths) {
    const parts = name.split('/');
    while (parts.length > 1) {
      parts.pop();
      if (paths.has(parts.join('/'))) throw failure('UNSAFE_PATH', 'Payload contains a file/directory path collision.');
    }
  }
  for (const name of REQUIRED_FILES) {
    if (!manifest.files.some(file => file.path === name)) throw failure('INVALID_PACKAGE', 'Payload is missing required file ' + name + '.');
  }
  return manifest;
}

function strictBase64(value, expectedBytes) {
  if (typeof value !== 'string' || value.length !== Math.ceil(expectedBytes / 3) * 4) {
    throw failure('INVALID_PACKAGE', 'Payload contains invalid base64 data.');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== expectedBytes || bytes.toString('base64') !== value) throw failure('INVALID_PACKAGE', 'Payload contains noncanonical base64 data.');
  return bytes;
}

function verifyFileMap(manifest, files, encoded) {
  const entries = files instanceof Map ? [...files] : (plainObject(files) ? Object.entries(files) : null);
  if (!entries || entries.length !== manifest.files.length) throw failure('INVALID_PACKAGE', 'Payload file set differs from the signed manifest.');
  const supplied = new Map(entries);
  const verified = new Map();
  for (const file of manifest.files) {
    if (!supplied.has(file.path)) throw failure('INVALID_PACKAGE', 'Payload is missing signed file ' + file.path + '.');
    const bytes = encoded ? strictBase64(supplied.get(file.path), file.size) : supplied.get(file.path);
    if (!Buffer.isBuffer(bytes) || bytes.length !== file.size || sha256(bytes) !== file.sha256) {
      throw failure('HASH_MISMATCH', 'Payload file bytes differ from the signed manifest: ' + file.path + '.');
    }
    verified.set(file.path, bytes);
  }
  return verified;
}

function verifyPackage(buffer, {trustedKeys, shellVersion, shellApi = 1} = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > MAX_COMPRESSED_BYTES) {
    throw failure('INVALID_PACKAGE', 'Payload exceeds the compressed size limit or is not a buffer.');
  }
  let document;
  try {
    const decoded = zlib.gunzipSync(buffer, {maxOutputLength: MAX_UNCOMPRESSED_BYTES});
    document = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(decoded));
  } catch {
    throw failure('INVALID_PACKAGE', 'Payload must be bounded gzip-compressed UTF-8 JSON.');
  }
  if (!exactKeys(document, ['manifest', 'signature', 'files'])) throw failure('INVALID_PACKAGE', 'Malformed payload envelope.');
  const manifest = validateManifest(document.manifest);
  const canonical = canonicalManifest(manifest);
  const signature = strictBase64(document.signature, 64);
  let validSignature = false;
  try {
    if (plainObject(trustedKeys) && Object.hasOwn(trustedKeys, manifest.keyId)) {
      const key = crypto.createPublicKey(trustedKeys[manifest.keyId]);
      validSignature = key.asymmetricKeyType === 'ed25519' && crypto.verify(null, Buffer.from(canonical, 'utf8'), key, signature);
    }
  } catch {}
  if (!validSignature) throw failure('INVALID_SIGNATURE', 'Payload signature is invalid or its signing key is not trusted.');
  if (manifest.shellApi !== shellApi || compareVersions(shellVersion, manifest.minShellVersion) < 0) {
    throw failure('INCOMPATIBLE_SHELL', 'Payload requires shell ' + manifest.minShellVersion + ' and shell API ' + manifest.shellApi + '.');
  }
  return {manifest, manifestHash: sha256(canonical), files: verifyFileMap(manifest, document.files, true)};
}

function createManifest({version, minShellVersion = '1.4.0', shellApi = 1, keyId, files, notes}) {
  const entries = files instanceof Map ? [...files] : (plainObject(files) ? Object.entries(files) : null);
  if (!entries || entries.some(([, bytes]) => !Buffer.isBuffer(bytes))) throw failure('INVALID_PACKAGE', 'Build files must be buffers.');
  const manifest = {
    format: 1, version, minShellVersion, shellApi, keyId,
    files: entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([filePath, bytes]) => ({path: filePath, size: bytes.length, sha256: sha256(bytes)})),
  };
  if (notes !== undefined) manifest.notes = notes;
  return validateManifest(manifest);
}

function createPackage({manifest, files, privateKey}) {
  validateManifest(manifest);
  const verifiedFiles = verifyFileMap(manifest, files, false);
  let key;
  try {
    key = privateKey?.type === 'private' ? privateKey : crypto.createPrivateKey(privateKey);
  } catch {
    throw failure('INVALID_SIGNING_KEY', 'An explicit PEM Ed25519 private key is required to build a payload.');
  }
  if (key.asymmetricKeyType !== 'ed25519') throw failure('INVALID_SIGNING_KEY', 'The payload signing key must be Ed25519.');
  const signature = crypto.sign(null, Buffer.from(canonicalManifest(manifest), 'utf8'), key).toString('base64');
  const encodedFiles = Object.fromEntries([...verifiedFiles].map(([name, bytes]) => [name, bytes.toString('base64')]));
  const bytes = Buffer.from(JSON.stringify({manifest, signature, files: encodedFiles}), 'utf8');
  if (bytes.length > MAX_UNCOMPRESSED_BYTES) throw failure('INVALID_PACKAGE', 'Payload JSON exceeds the decompressed size limit.');
  const compressed = zlib.gzipSync(bytes, {level: 9});
  if (compressed.length > MAX_COMPRESSED_BYTES) throw failure('INVALID_PACKAGE', 'Payload exceeds the compressed size limit.');
  return compressed;
}

module.exports = {
  MAX_COMPRESSED_BYTES, MAX_UNCOMPRESSED_BYTES, MAX_FILES, REQUIRED_FILES,
  canonicalManifest, compareVersions, createManifest, createPackage, failure,
  isShellOwnedPath, sha256, validatePayloadPath, verifyPackage,
};
