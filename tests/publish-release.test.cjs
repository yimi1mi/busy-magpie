'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { publishRelease, createGitHubApi, parseArgs } = require('../tools/publish-release.cjs');
const SOURCE = 'a'.repeat(40);
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));

function fixture(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'busy-release-test-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const files = { 'Busy.Magpie-1.4.0-windows-x64.exe': 'windows fixture', 'Busy.Magpie-1.4.0-mac-arm64.zip': 'mac fixture', SHA256SUMS: 'checksums fixture' };
  const assets = Object.entries(files).map(([name, bytes]) => {
    fs.writeFileSync(path.join(directory, name), bytes);
    return { name, size: Buffer.byteLength(bytes), sha256: digest(bytes) };
  });
  const manifest = { schema: 1, version: '1.4.0', sourceSha: SOURCE, assets };
  fs.writeFileSync(path.join(directory, 'release-manifest.json'), JSON.stringify(manifest));
  return { directory, manifest, options: { directory, mode: 'prerelease', repository: 'owner/project', sourceSha: SOURCE },
    remoteAssets: () => assets.map((asset, index) => ({ id: index + 10, name: asset.name, size: asset.size, digest: `sha256:${asset.sha256}`, state: 'uploaded' })) };
}

function fakeApi({ tag = SOURCE, release = null, failUpload = false, corruptUpload = false, annotated = false, finalExtra = false } = {}) {
  const state = { tag, release: release ? clone(release) : null, calls: [], uploads: 0 };
  const make = () => ({ id: 1, tag_name: 'v1.4.0', target_commitish: SOURCE, name: 'v1.4.0',
    body: 'Existing release notes', html_url: 'https://github.com/owner/project/releases/tag/v1.4.0', assets: [], draft: true, prerelease: true });
  if (state.release) state.release = { ...make(), ...state.release };
  const api = { async request(method, endpoint, options = {}) {
    state.calls.push({ method, endpoint, ...(options.json ? { json: clone(options.json) } : {}), ...(options.file ? { file: path.basename(options.file) } : {}) });
    const url = new URL(endpoint, 'https://api.github.com');
    const route = url.pathname.replace('/repos/owner/project', '');
    if (method === 'GET' && route.startsWith('/git/ref/tags/')) {
      if (!state.tag) throw Object.assign(new Error('not found'), { status: 404 });
      return { object: { type: annotated ? 'tag' : 'commit', sha: annotated ? 'b'.repeat(40) : state.tag } };
    }
    if (method === 'GET' && route.startsWith('/git/tags/')) return { object: { type: 'commit', sha: state.tag } };
    if (method === 'GET' && route.startsWith('/releases/tags/')) {
      if (!state.release || state.release.draft) throw Object.assign(new Error('not found'), { status: 404 });
      return clone(state.release);
    }
    if (route === '/releases') {
      if (method === 'GET') return state.release ? [clone(state.release)] : [];
      if (method === 'POST') { state.release = { ...make(), ...options.json, body: 'Generated release notes' }; return clone(state.release); }
    }
    if (route === '/releases/1/assets') {
      if (method === 'GET') {
        const list = clone(state.release.assets);
        if (finalExtra && state.uploads) list.push({ id: 500, name: 'unrelated.txt', state: 'uploaded', size: 1, digest: `sha256:${'c'.repeat(64)}` });
        return list;
      }
      if (method === 'POST') {
        assert.equal(state.release.draft, true, 'uploads must happen while hidden');
        state.uploads += 1;
        if (failUpload) throw new Error('simulated upload failed');
        const bytes = fs.readFileSync(options.file);
        assert.equal(bytes.length, options.size);
        const asset = { id: 100 + state.uploads, name: url.searchParams.get('name'), size: bytes.length,
          digest: `sha256:${corruptUpload ? 'f'.repeat(64) : digest(bytes)}`, state: 'uploaded' };
        state.release.assets.push(asset);
        return clone(asset);
      }
    }
    if (method === 'DELETE' && route.startsWith('/releases/assets/')) {
      assert.equal(state.release.draft, true, 'replacements must happen while hidden');
      const id = Number(route.split('/').at(-1));
      state.release.assets = state.release.assets.filter(asset => asset.id !== id);
      return null;
    }
    if (route === '/releases/1') {
      if (method === 'GET') return clone(state.release);
      if (method === 'PATCH') {
        Object.assign(state.release, options.json);
        if (!state.release.draft && !state.tag) state.tag = state.release.target_commitish;
        return clone(state.release);
      }
    }
    throw new Error(`Unexpected fake API request ${method} ${endpoint}`);
  } };
  return { api, state, writes: () => state.calls.filter(call => call.method !== 'GET') };
}

test('build mode verifies all local bytes without making API requests', async t => {
  const c = fixture(t);
  const result = await publishRelease({ ...c.options, mode: 'build', api: { request() { throw new Error('network is forbidden'); } } });
  assert.equal(result.status, 'verified');
  assert.equal(result.assets.length, 3);
  assert.ok(!result.assets.includes('release-manifest.json'));
});

test('local corruption, extra files and source mismatch fail before remote mutations', async t => {
  const c = fixture(t);
  const remote = fakeApi();
  fs.writeFileSync(path.join(c.directory, c.manifest.assets[0].name), 'corrupt fixture');
  await assert.rejects(publishRelease({ ...c.options, api: remote.api }), { code: 'LOCAL_ASSET_MISMATCH' });
  assert.deepEqual(remote.state.calls, []);
  await assert.rejects(publishRelease({ ...c.options, sourceSha: 'b'.repeat(40), api: remote.api }), { code: 'INVALID_MANIFEST' });
  fs.writeFileSync(path.join(c.directory, c.manifest.assets[0].name), 'windows fixture');
  fs.writeFileSync(path.join(c.directory, 'unexpected.zip'), 'extra');
  await assert.rejects(publishRelease({ ...c.options, api: remote.api }), { code: 'UNEXPECTED_LOCAL_ASSET' });
  assert.deepEqual(remote.state.calls, []);
});

test('an existing tag on another commit is rejected without changing tags or releases', async t => {
  const c = fixture(t);
  const remote = fakeApi({ tag: 'c'.repeat(40) });
  await assert.rejects(publishRelease({ ...c.options, api: remote.api }), { code: 'TAG_SOURCE_MISMATCH' });
  assert.deepEqual(remote.writes(), []);
});

test('new release stays draft until every uploaded size and digest is verified', async t => {
  const c = fixture(t);
  const remote = fakeApi({ tag: null });
  const result = await publishRelease({ ...c.options, api: remote.api });
  assert.equal(result.status, 'published');
  assert.equal(remote.state.release.draft, false);
  assert.equal(remote.state.release.prerelease, true);
  assert.equal(remote.state.release.make_latest, 'false');
  const create = remote.writes()[0];
  assert.equal(create.json.target_commitish, SOURCE);
  assert.equal(create.json.draft, true);
  assert.equal(create.json.generate_release_notes, true);
  assert.equal(remote.state.tag, SOURCE);
  assert.deepEqual(remote.state.release.assets.map(asset => asset.name).sort(), c.manifest.assets.map(asset => asset.name).sort());
  assert.ok(remote.writes().at(-1).json.draft === false);
});

test('annotated tag is resolved to its commit and formal publication becomes latest', async t => {
  const c = fixture(t);
  const remote = fakeApi({ annotated: true });
  await publishRelease({ ...c.options, mode: 'release', api: remote.api });
  assert.ok(remote.state.calls.some(call => call.endpoint.includes('/git/tags/')));
  assert.equal(remote.state.release.prerelease, false);
  assert.equal(remote.state.release.make_latest, 'true');
});

for (const mode of ['prerelease', 'release']) {
  test(`same formal assets are idempotent in ${mode} mode and preserve formal state`, async t => {
    const c = fixture(t);
    const remote = fakeApi({ release: { draft: false, prerelease: false, assets: c.remoteAssets() } });
    const before = clone(remote.state.release);
    const result = await publishRelease({ ...c.options, mode, api: remote.api });
    assert.equal(result.status, 'unchanged');
    assert.equal(result.mode, 'release');
    assert.deepEqual(remote.writes(), []);
    assert.deepEqual(remote.state.release, before);
  });
}

test('different or missing formal assets cannot be replaced or hidden', async t => {
  const c = fixture(t);
  for (const assets of [[], c.remoteAssets().map(asset => ({ ...asset, digest: `sha256:${'f'.repeat(64)}` }))]) {
    const remote = fakeApi({ release: { draft: false, prerelease: false, assets } });
    await assert.rejects(publishRelease({ ...c.options, api: remote.api }), { code: 'FORMAL_RELEASE_IMMUTABLE' });
    assert.deepEqual(remote.writes(), []);
  }
});

test('unknown existing asset is refused without deletion or visibility changes', async t => {
  const c = fixture(t);
  for (const draft of [true, false]) {
    const remote = fakeApi({ release: { draft, prerelease: !draft, assets: [...c.remoteAssets(), { id: 99, name: 'keep-me.txt' }] } });
    await assert.rejects(publishRelease({ ...c.options, api: remote.api }), { code: 'UNEXPECTED_REMOTE_ASSET' });
    assert.deepEqual(remote.writes(), []);
  }
});

test('existing prerelease is hidden before replacement and notes are preserved', async t => {
  const c = fixture(t);
  const assets = c.remoteAssets();
  assets[0].digest = `sha256:${'c'.repeat(64)}`;
  const remote = fakeApi({ release: { draft: false, prerelease: true, assets, body: 'Keep these release notes' } });
  await publishRelease({ ...c.options, mode: 'release', api: remote.api });
  assert.deepEqual(remote.writes()[0].json, { draft: true });
  assert.equal(remote.state.uploads, 1);
  assert.equal(remote.state.release.body, 'Keep these release notes');
  assert.equal(remote.state.release.prerelease, false);
});

test('same prerelease assets are idempotent without new uploads or visibility changes', async t => {
  const c = fixture(t);
  const remote = fakeApi({ release: { draft: false, prerelease: true, assets: c.remoteAssets() } });
  assert.equal((await publishRelease({ ...c.options, api: remote.api })).status, 'unchanged');
  assert.deepEqual(remote.writes(), []);
});

for (const fault of ['failUpload', 'corruptUpload', 'finalExtra']) {
  test(`${fault} keeps the release draft and never publishes partial assets`, async t => {
    const c = fixture(t);
    const remote = fakeApi({ [fault]: true, release: { draft: false, prerelease: true, assets: [] } });
    await assert.rejects(publishRelease({ ...c.options, mode: 'release', api: remote.api }));
    assert.equal(remote.state.release.draft, true);
    assert.ok(!remote.writes().some(call => call.json?.draft === false));
  });
}

test('a draft without a tag cannot silently switch to a different source commit', async t => {
  const c = fixture(t);
  const remote = fakeApi({ tag: null, release: { target_commitish: 'main' } });
  await assert.rejects(publishRelease({ ...c.options, api: remote.api }), { code: 'RELEASE_SOURCE_UNVERIFIED' });
  assert.deepEqual(remote.writes(), []);
});

test('a lost publish response is reconciled read-only without downgrading the formal release', async t => {
  const c = fixture(t);
  const remote = fakeApi({ tag: null });
  const request = remote.api.request.bind(remote.api);
  remote.api.request = async (method, endpoint, options = {}) => {
    const result = await request(method, endpoint, options);
    if (method === 'PATCH' && options.json?.draft === false) throw new Error('response lost after publishing');
    return result;
  };
  const result = await publishRelease({ ...c.options, mode: 'release', api: remote.api });
  assert.equal(result.status, 'published');
  assert.equal(remote.state.release.draft, false);
  assert.equal(remote.state.release.prerelease, false);
  assert.equal(remote.writes().filter(call => call.method === 'PATCH').length, 1);
});

test('unknown publish outcome is reported honestly without a destructive visibility rollback', async t => {
  const c = fixture(t);
  const remote = fakeApi({ tag: null });
  const request = remote.api.request.bind(remote.api);
  let disconnected = false;
  remote.api.request = async (method, endpoint, options = {}) => {
    if (disconnected) throw new Error('network unavailable');
    const result = await request(method, endpoint, options);
    if (method === 'PATCH' && options.json?.draft === false) { disconnected = true; throw new Error('response lost'); }
    return result;
  };
  await assert.rejects(publishRelease({ ...c.options, mode: 'release', api: remote.api }), { code: 'PUBLISH_OUTCOME_UNKNOWN' });
  assert.equal(remote.state.release.draft, false);
  assert.equal(remote.state.release.prerelease, false);
  assert.equal(remote.writes().filter(call => call.method === 'PATCH').length, 1);
});

test('CLI options are explicit and reject unknown, missing and duplicate arguments', () => {
  const args = ['--directory', 'release', '--mode', 'build', '--repository', 'owner/project', '--source-sha', SOURCE];
  assert.equal(parseArgs(args).sourceSha, SOURCE);
  assert.throws(() => parseArgs(args.slice(0, -2)), { code: 'INVALID_ARGUMENTS' });
  assert.throws(() => parseArgs([...args, '--mode', 'release']), { code: 'INVALID_ARGUMENTS' });
});

test('API failures never include authentication credentials in error messages', async () => {
  const token = 'secret-never-log-this-token';
  const api = createGitHubApi({ token, fetchImpl: async (_url, options) => {
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    return { ok: false, status: 403, body: { async cancel() {} } };
  } });
  await assert.rejects(api.request('POST', '/repos/owner/project/releases', { json: {} }), error => {
    assert.ok(!error.message.includes(token));
    return error.status === 403;
  });
});
