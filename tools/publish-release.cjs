'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function failure(code, message) { return Object.assign(new Error(message), { code }); }
const SHA = /^[a-f0-9]{40}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

async function fileHash(filename) {
  const hash = crypto.createHash('sha256');
  for await (const bytes of fs.createReadStream(filename)) hash.update(bytes);
  return hash.digest('hex');
}

async function verifyDirectory(directory, sourceSha) {
  if (!SHA.test(sourceSha || '')) throw failure('INVALID_SOURCE', 'A complete lowercase source commit SHA is required');
  const root = fs.realpathSync(directory);
  const manifestPath = path.join(root, 'release-manifest.json');
  const manifestStat = fs.lstatSync(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) throw failure('INVALID_MANIFEST', 'Manifest must be a regular file');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.schema !== 1 || !VERSION.test(manifest.version || '') || manifest.sourceSha !== sourceSha
    || !Array.isArray(manifest.assets) || manifest.assets.length === 0) {
    throw failure('INVALID_MANIFEST', 'Manifest schema, version, source SHA or asset list is invalid');
  }
  const names = new Set();
  const assets = [];
  for (const entry of manifest.assets) {
    if (!entry || typeof entry.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,254}$/.test(entry.name)
      || entry.name.toLowerCase() === 'release-manifest.json' || names.has(entry.name.toLowerCase())
      || !Number.isSafeInteger(entry.size) || entry.size < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256 || '')) {
      throw failure('INVALID_MANIFEST', 'Manifest contains an invalid or duplicate asset');
    }
    names.add(entry.name.toLowerCase());
    const filename = path.join(root, entry.name);
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.size || await fileHash(filename) !== entry.sha256) {
      throw failure('LOCAL_ASSET_MISMATCH', `Local asset does not match its manifest: ${entry.name}`);
    }
    assets.push({ name: entry.name, size: entry.size, sha256: entry.sha256, filename });
  }
  const expected = new Set(['release-manifest.json', ...assets.map(asset => asset.name)]);
  if (fs.readdirSync(root).some(name => !expected.has(name))) {
    throw failure('UNEXPECTED_LOCAL_ASSET', 'Release directory contains files not listed in the manifest');
  }
  return { version: manifest.version, sourceSha, assets };
}

function createGitHubApi({ token = process.env.GITHUB_TOKEN, fetchImpl = globalThis.fetch } = {}) {
  if (!token) throw failure('MISSING_TOKEN', 'GITHUB_TOKEN is required for publishing');
  return { async request(method, endpoint, { json, file, size, upload = false } = {}) {
    if (!endpoint.startsWith('/repos/')) throw failure('INVALID_API_PATH', 'Unexpected GitHub API path');
    const host = upload ? 'https://uploads.github.com' : 'https://api.github.com';
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'busy-magpie-release' };
    let body;
    if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
    if (file) { headers['Content-Type'] = 'application/octet-stream'; headers['Content-Length'] = String(size); body = fs.createReadStream(file); }
    let response;
    try {
      response = await fetchImpl(host + endpoint, { method, headers, body, redirect: 'error',
        signal: AbortSignal.timeout(180000), ...(file ? { duplex: 'half' } : {}) });
    } catch {
      if (file) body.destroy();
      throw failure('GITHUB_NETWORK_ERROR', `GitHub ${method} ${endpoint} did not complete`);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw Object.assign(failure('GITHUB_HTTP_ERROR', `GitHub ${method} ${endpoint} returned HTTP ${response.status}`), { status: response.status });
    }
    return response.status === 204 ? null : response.json();
  } };
}

async function listAll(api, endpoint) {
  const values = [];
  for (let page = 1; page <= 100; page += 1) {
    const batch = await api.request('GET', `${endpoint}?per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw failure('INVALID_API_RESPONSE', 'GitHub did not return a collection');
    values.push(...batch);
    if (batch.length < 100) return values;
  }
  throw failure('COLLECTION_TOO_LARGE', 'GitHub collection exceeds the supported verification bound');
}

async function tagCommit(api, base, tag) {
  let ref;
  try { ref = await api.request('GET', `${base}/git/ref/tags/${encodeURIComponent(tag)}`); }
  catch (error) { if (error.status === 404) return null; throw error; }
  let object = ref.object;
  for (let depth = 0; depth < 10; depth += 1) {
    if (!object || !SHA.test(object.sha || '')) break;
    if (object.type === 'commit') return object.sha;
    if (object.type !== 'tag') break;
    object = (await api.request('GET', `${base}/git/tags/${object.sha}`)).object;
  }
  throw failure('INVALID_TAG', 'Release tag does not resolve to a commit');
}

async function checkTag(api, base, tag, sourceSha) {
  const commit = await tagCommit(api, base, tag);
  if (commit && commit !== sourceSha) throw failure('TAG_SOURCE_MISMATCH', `${tag} points to another commit; tags are never moved automatically`);
  return commit;
}

function assetMatches(remote, expected) {
  return remote?.name === expected.name && remote.state === 'uploaded' && remote.size === expected.size
    && remote.digest === `sha256:${expected.sha256}`;
}

function indexAssets(remote, expected) {
  const expectedNames = new Set(expected.map(asset => asset.name));
  const result = new Map();
  for (const asset of remote) {
    if (!expectedNames.has(asset.name) || result.has(asset.name)) {
      throw failure('UNEXPECTED_REMOTE_ASSET', 'Release contains an unknown or duplicate asset; nothing will be deleted automatically');
    }
    if (!Number.isSafeInteger(asset.id) || asset.id <= 0) throw failure('INVALID_API_RESPONSE', 'Release asset has an invalid ID');
    result.set(asset.name, asset);
  }
  return result;
}

function allMatch(remote, expected) {
  const indexed = indexAssets(remote, expected);
  return indexed.size === expected.length && expected.every(asset => assetMatches(indexed.get(asset.name), asset));
}

async function findRelease(api, base, tag) {
  try { return await api.request('GET', `${base}/releases/tags/${encodeURIComponent(tag)}`); }
  catch (error) { if (error.status !== 404) throw error; }
  const releases = (await listAll(api, `${base}/releases`)).filter(release => release.tag_name === tag);
  if (releases.length > 1) throw failure('AMBIGUOUS_RELEASE', 'More than one release uses this tag');
  return releases[0] || null;
}

async function publishRelease({ directory, mode, repository, sourceSha, api }) {
  if (!['build', 'prerelease', 'release'].includes(mode)) throw failure('INVALID_MODE', 'Mode must be build, prerelease or release');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '')) throw failure('INVALID_REPOSITORY', 'Repository must be owner/repo');
  const local = await verifyDirectory(directory, sourceSha);
  const tag = `v${local.version}`;
  if (mode === 'build') return { status: 'verified', mode, tag, sourceSha, assets: local.assets.map(({ name }) => name) };
  api ||= createGitHubApi();
  const base = `/repos/${repository}`;
  const commit = await checkTag(api, base, tag, sourceSha);
  let release = await findRelease(api, base, tag);
  let remote = [];
  if (release) {
    if (!Number.isSafeInteger(release.id) || release.id <= 0 || release.tag_name !== tag) throw failure('INVALID_API_RESPONSE', 'GitHub returned a different release');
    if (!commit && release.target_commitish !== sourceSha) throw failure('RELEASE_SOURCE_UNVERIFIED', 'Draft without a tag must target the exact source SHA');
    if (!commit && !release.draft) throw failure('RELEASE_SOURCE_UNVERIFIED', 'Published release is missing its source tag');
    remote = await listAll(api, `${base}/releases/${release.id}/assets`);
    const matches = allMatch(remote, local.assets);
    if (!release.draft && !release.prerelease) {
      if (!matches) throw failure('FORMAL_RELEASE_IMMUTABLE', 'Existing formal release assets differ; replacement or downgrade is refused');
      return { status: 'unchanged', mode: 'release', tag, url: release.html_url };
    }
    if (!release.draft && release.prerelease && mode === 'prerelease' && matches) {
      return { status: 'unchanged', mode, tag, url: release.html_url };
    }
    if (!release.draft) release = await api.request('PATCH', `${base}/releases/${release.id}`, { json: { draft: true } });
  } else {
    release = await api.request('POST', `${base}/releases`, { json: { tag_name: tag, target_commitish: sourceSha,
      name: tag, draft: true, prerelease: mode === 'prerelease', generate_release_notes: true } });
  }
  if (!release.draft || !Number.isSafeInteger(release.id) || release.id <= 0 || release.tag_name !== tag) {
    throw failure('DRAFT_REQUIRED', 'The matching release must be a draft before uploading');
  }
  const releasePath = `${base}/releases/${release.id}`;
  const existing = indexAssets(remote, local.assets);
  for (const expected of local.assets) {
    if (assetMatches(existing.get(expected.name), expected)) continue;
    // Re-read immediately before upload. The server digest below also checks bytes
    // if a local file changes after this read.
    const stat = fs.lstatSync(expected.filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== expected.size || await fileHash(expected.filename) !== expected.sha256) {
      throw failure('LOCAL_ASSET_MISMATCH', `Local asset changed before upload: ${expected.name}`);
    }
    const previous = existing.get(expected.name);
    if (previous) await api.request('DELETE', `${base}/releases/assets/${previous.id}`);
    const uploaded = await api.request('POST', `${releasePath}/assets?name=${encodeURIComponent(expected.name)}`,
      { file: expected.filename, size: expected.size, upload: true });
    if (!assetMatches(uploaded, expected)) throw failure('ASSET_VERIFY_FAILED', `Uploaded asset size or digest differs: ${expected.name}`);
  }
  const verified = await listAll(api, `${releasePath}/assets`);
  if (!allMatch(verified, local.assets)) throw failure('ASSET_VERIFY_FAILED', 'Complete server asset list does not match the manifest');
  const finalCommit = await checkTag(api, base, tag, sourceSha);
  const current = await api.request('GET', releasePath);
  if (!current.draft || current.tag_name !== tag || (!finalCommit && current.target_commitish !== sourceSha)) {
    throw failure('CONCURRENT_RELEASE_CHANGE', 'Release changed during verification; publication was stopped');
  }
  let published;
  try {
    published = await api.request('PATCH', releasePath,
      { json: { draft: false, prerelease: mode === 'prerelease', make_latest: mode === 'release' ? 'true' : 'false' } });
  } catch (publishError) {
    // A lost HTTP response cannot prove that publication failed. Reconcile with
    // read-only requests; never turn a possibly published formal release back into a draft.
    let observed;
    try { observed = await api.request('GET', releasePath); }
    catch { throw failure('PUBLISH_OUTCOME_UNKNOWN', 'Publication response was lost; inspect the release before retrying'); }
    if (observed.draft) throw publishError;
    try {
      const observedAssets = await listAll(api, `${releasePath}/assets`);
      const observedCommit = await checkTag(api, base, tag, sourceSha);
      if (observed.tag_name !== tag || observed.prerelease !== (mode === 'prerelease')
        || observedCommit !== sourceSha || !allMatch(observedAssets, local.assets)) throw new Error('Observed release differs');
      published = observed;
    } catch { throw failure('PUBLISH_OUTCOME_UNKNOWN', 'Publication response was lost and the release could not be fully verified'); }
  }
  if (published.draft || published.prerelease !== (mode === 'prerelease')) throw failure('PUBLISH_UNCONFIRMED', 'GitHub did not confirm the requested release state');
  if (await checkTag(api, base, tag, sourceSha) !== sourceSha) throw failure('PUBLISH_UNCONFIRMED', 'Published source tag could not be verified');
  return { status: 'published', mode, tag, url: published.html_url };
}

function parseArgs(argv) {
  const options = {};
  const names = { '--directory': 'directory', '--mode': 'mode', '--repository': 'repository', '--source-sha': 'sourceSha' };
  for (let index = 0; index < argv.length; index += 2) {
    const name = names[argv[index]], value = argv[index + 1];
    if (!name || !value || value.startsWith('--') || Object.hasOwn(options, name)) throw failure('INVALID_ARGUMENTS', 'Expected --directory, --mode, --repository and --source-sha exactly once');
    options[name] = value;
  }
  if (Object.keys(options).length !== 4) throw failure('INVALID_ARGUMENTS', 'Expected --directory, --mode, --repository and --source-sha exactly once');
  return options;
}

if (require.main === module) {
  Promise.resolve().then(() => publishRelease(parseArgs(process.argv.slice(2)))).then(result => {
    process.stdout.write(`${result.status} ${result.tag}${result.url ? ` ${result.url}` : ` (${result.assets.length} assets)`}\n`);
  }).catch(error => {
    const token = process.env.GITHUB_TOKEN;
    const message = `${error.code || 'PUBLISH_FAILED'}: ${error.message}`;
    process.stderr.write(`${token ? message.split(token).join('[REDACTED]') : message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { publishRelease, verifyDirectory, createGitHubApi, parseArgs };
