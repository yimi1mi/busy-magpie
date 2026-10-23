import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

export const RELEASE = 'https://github.com/yimi1mi/busy-magpie/releases/latest';
const API = 'https://api.github.com/repos/yimi1mi/busy-magpie/releases/latest';
const HEADERS = { Accept: 'application/vnd.github+json', 'User-Agent': 'busy-magpie-plugin' };
const runFile = promisify(execFile);

export function selectAsset(release, platform, arch) {
  let suffix;
  if (platform === 'win32') suffix = '-win-x64.exe';
  else if (platform === 'darwin' && ['arm64', 'x64'].includes(arch)) suffix = `-mac-${arch}.zip`;
  else throw new Error(`automatic installation is not supported on ${platform}/${arch}`);
  const asset = (release.assets || []).find(item => item.name?.toLowerCase().endsWith(suffix));
  if (!asset) throw new Error(`no ${suffix.slice(1)} installer in the latest release`);
  return asset;
}

async function request(fetchImpl, url, timeout = 30000) {
  const response = await fetchImpl(url, { headers: HEADERS, signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw new Error(`download answered ${response.status}: ${url}`);
  return response;
}

async function checksum(asset, release, fetchImpl) {
  const digest = /^sha256:([a-f0-9]{64})$/i.exec(asset.digest || '');
  if (digest) return digest[1].toLowerCase();
  // Older releases may expose checksums as files instead of GitHub's digest.
  const sidecar = (release.assets || []).find(item => item.name === `${asset.name}.sha256`)
    || (release.assets || []).find(item => item.name === 'SHA256SUMS');
  if (sidecar) {
    const response = await request(fetchImpl, sidecar.browser_download_url);
    for (const line of (await response.text()).split(/\r?\n/)) {
      const match = /^([a-f0-9]{64})(?:\s+\*?(.+))?$/i.exec(line.trim());
      if (match && (match[2] === asset.name || (!match[2] && sidecar.name === `${asset.name}.sha256`))) {
        return match[1].toLowerCase();
      }
    }
  }
  throw new Error(`no SHA-256 checksum for ${asset.name}`);
}

// Options also let installation be exercised in an isolated directory with a
// release fixture. Production always uses GitHub Releases and the user's home.
export async function installApp({
  platform = process.platform,
  arch = process.arch,
  home = homedir(),
  temporary = tmpdir(),
  fetchImpl = globalThis.fetch,
  run = (file, args) => runFile(file, args, { windowsHide: true, timeout: 300000 }),
  findApp = () => '',
  notify = () => {},
  log = message => console.log(`[busy-magpie] ${message}`),
} = {}) {
  if (platform !== 'win32' && platform !== 'darwin') {
    throw new Error(`automatic installation is not supported on ${platform}/${arch}`);
  }
  log('downloading the latest release installer');
  notify('Busy Magpie', '正在下载安装包，完成后会自动打开…');
  const release = await (await request(fetchImpl, API)).json();
  const asset = selectAsset(release, platform, arch);
  const expected = await checksum(asset, release, fetchImpl);
  const work = await fs.mkdtemp(path.join(temporary, 'busy-magpie-'));
  let stage;
  try {
    const response = await request(fetchImpl, asset.browser_download_url, 10 * 60 * 1000);
    const body = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(body).digest('hex') !== expected) {
      throw new Error('installer checksum does not match the release');
    }
    const archive = path.join(work, platform === 'darwin' ? 'busy-magpie.zip' : 'busy-magpie-setup.exe');
    await fs.writeFile(archive, body);
    log(`installing ${release.tag_name} (${asset.name})`);
    notify('Busy Magpie', '下载完成，正在安装…');

    if (platform === 'win32') {
      await run(archive, ['/S']);
      const installed = findApp();
      if (!installed) throw new Error('installer finished, but Busy Magpie.exe was not found');
      return installed;
    }

    const applications = path.join(home, 'Applications');
    const destination = path.join(applications, 'Busy Magpie.app');
    await fs.mkdir(applications, { recursive: true });
    // Extract next to the destination so the final rename is atomic, even if
    // the system temporary directory lives on a different volume.
    stage = await fs.mkdtemp(path.join(applications, '.busy-magpie-install-'));
    await run('/usr/bin/ditto', ['-x', '-k', archive, stage]);
    const bundle = path.join(stage, 'Busy Magpie.app');
    const relativeExe = path.join('Contents', 'MacOS', 'Busy Magpie');
    if (!(await fs.lstat(bundle)).isDirectory() || !(await fs.stat(path.join(bundle, relativeExe))).isFile()) {
      throw new Error('release ZIP does not contain a valid Busy Magpie.app');
    }
    await fs.access(path.join(bundle, relativeExe), constants.X_OK);
    // Another host or a manual install may have finished while downloading.
    // Reuse it; never merge or overwrite an existing application bundle.
    const existing = findApp();
    if (existing) return existing;
    try {
      await fs.lstat(destination);
      throw new Error(`installation destination already exists: ${destination}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await fs.rename(bundle, destination);
    log(`installed ${destination}`);
    return path.join(destination, relativeExe);
  } finally {
    if (stage) await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
    await fs.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
