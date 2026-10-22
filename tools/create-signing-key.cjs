'use strict';

// Run once, then back up the private key outside the repository. Only its
// public half belongs in the shell; losing it requires a new shell release.
const fs = require('node:fs');
const path = require('node:path');
const { generateKeyPairSync } = require('node:crypto');
const [keyFile, keyId, publicFile] = process.argv.slice(2);
if (!keyFile || !/^[a-zA-Z0-9_-]+$/.test(keyId || '') || !publicFile) {
  throw new Error('Usage: node tools/create-signing-key.cjs PRIVATE.pem KEY_ID PUBLIC.json');
}
if (fs.existsSync(keyFile) || fs.existsSync(publicFile)) throw new Error('Refusing to overwrite an existing signing key or trust file');
const pair = generateKeyPairSync('ed25519');
fs.mkdirSync(path.dirname(path.resolve(keyFile)), { recursive: true });
fs.mkdirSync(path.dirname(path.resolve(publicFile)), { recursive: true });
fs.writeFileSync(keyFile, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 });
fs.writeFileSync(publicFile, JSON.stringify({ [keyId]: pair.publicKey.export({ type: 'spki', format: 'pem' }) }, null, 2) + '\n', { flag: 'wx' });
console.log('Created private signing key and public trust file. Private key contents were not printed.');
