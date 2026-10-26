import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parse } from 'yaml';

const defaultLock = JSON.parse(await readFile(new URL('./distribution-notices.lock.json', import.meta.url), 'utf8'));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
function relativePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.split('/').some((part) => !part || part === '.' || part === '..') || /[\0\r\n]/.test(value) || path.isAbsolute(value)) throw new Error('distribution_notice_path');
  return value;
}
async function regularBytes(root, name, maximum = 32 * 1024 * 1024) {
  const base = await realpath(root); const selected = path.join(base, relativePath(name));
  try {
    const metadata = await lstat(selected); const actual = await realpath(selected);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maximum || !actual.startsWith(base + path.sep)) throw new Error();
    return await readFile(selected);
  } catch { throw new Error('distribution_notice_unavailable'); }
}
function checkNotice(bytes, record) {
  if (bytes.length !== record.bytes || sha256(bytes) !== record.sha256) throw new Error('distribution_notice_changed');
}
async function writeNotices(directory, records, originals, receipt) {
  await mkdir(directory, { recursive: true });
  const metadata = await lstat(directory); if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('distribution_notice_path');
  const base = await realpath(directory);
  for (const [name, bytes] of [...originals, ['sources.json', Buffer.from(JSON.stringify(receipt, null, 2) + '\n')]]) {
    const selected = path.join(base, relativePath(name));
    await mkdir(path.dirname(selected), { recursive: true });
    if (!(await realpath(path.dirname(selected))).startsWith(base + path.sep) && path.dirname(selected) !== base) throw new Error('distribution_notice_path');
    const existing = await lstat(selected).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error('distribution_notice_path');
    await writeFile(selected, bytes);
  }
  await verifyNotices(directory, records, receipt);
}
async function verifyNotices(directory, records, receipt) {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('distribution_notice_path');
  const files = [];
  const walk = async (selected, prefix = '') => {
    for (const entry of await readdir(selected, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) await walk(path.join(selected, entry.name), name + '/');
      else if (entry.isFile()) files.push(name);
      else throw new Error('distribution_notice_path');
    }
  };
  await walk(directory);
  if (JSON.stringify(files.sort()) !== JSON.stringify([...records.map((record) => record.output), 'sources.json'].sort())) throw new Error('distribution_notice_inventory');
  for (const record of records) checkNotice(await regularBytes(directory, record.output), record);
  const expected = Buffer.from(JSON.stringify(receipt, null, 2) + '\n');
  if (!(await regularBytes(directory, 'sources.json')).equals(expected)) throw new Error('distribution_notice_receipt_changed');
}

function frontendDependencyPath(packageLock, name) {
  const importer = packageLock.importers?.desktop;
  if (String(packageLock.lockfileVersion) !== '9.0' || !importer) throw new Error('distribution_package_changed');
  const queue = Object.entries({ ...importer.dependencies, ...importer.devDependencies }).map(([dependency, value]) => [{ name: dependency, version: value.version }]);
  const visited = new Set();
  for (let index = 0; index < queue.length; index++) {
    const chain = queue[index]; const selected = chain.at(-1); const key = `${selected.name}@${selected.version}`;
    if (visited.has(key)) continue;
    visited.add(key);
    if (selected.name === name) return chain;
    const snapshot = packageLock.snapshots?.[key];
    for (const [dependency, version] of Object.entries({ ...snapshot?.dependencies, ...snapshot?.optionalDependencies })) {
      queue.push([...chain, { name: dependency, version }]);
    }
  }
  throw new Error('distribution_package_changed');
}
export async function prepareFrontendNotices({ projectDirectory, outputDirectory, lock = defaultLock }) {
  const packageLock = parse((await regularBytes(path.dirname(projectDirectory), 'pnpm-lock.yaml', 4 * 1024 * 1024)).toString('utf8'));
  const originals = [];
  for (const record of lock.frontend) {
    const chain = frontendDependencyPath(packageLock, record.name);
    const pinned = packageLock.packages?.[`${record.name}@${record.version}`];
    if (chain.at(-1).version?.split('(')[0] !== record.version || pinned?.resolution?.tarball !== record.resolved || pinned?.resolution?.integrity !== record.integrity) throw new Error('distribution_package_changed');
    // 从实际依赖方解析，兼容 pnpm 中仅链接在 react-dom 下面的 scheduler。
    let packageFile = path.join(projectDirectory, 'package.json');
    try {
      for (const dependency of chain) packageFile = createRequire(packageFile).resolve(relativePath(dependency.name) + '/package.json');
    } catch { throw new Error('distribution_notice_unavailable'); }
    const installed = path.dirname(packageFile);
    const metadata = JSON.parse(await regularBytes(installed, 'package.json', 1024 * 1024));
    if (metadata.name !== record.name || metadata.version !== record.version) throw new Error('distribution_package_changed');
    if (!record.member.startsWith('package/')) throw new Error('distribution_notice_path');
    const bytes = await regularBytes(installed, record.member.slice('package/'.length)); checkNotice(bytes, record);
    originals.push([record.output, bytes]);
  }
  await writeNotices(outputDirectory, lock.frontend, originals, lock.frontend);
}
export async function verifyFrontendNotices({ directory, lock = defaultLock }) {
  await verifyNotices(directory, lock.frontend, lock.frontend);
}

function electronRelease(version, lock) {
  if (version !== lock.electron.version) throw new Error('package_electron_version_changed');
  return lock.electron;
}
export async function verifyElectronArchive({ directory, version, arch, lock = defaultLock }) {
  const release = electronRelease(version, lock); const record = release.archives.find((archive) => archive.arch === arch);
  if (!record) throw new Error('package_offline_archive_unavailable');
  const selected = path.join(directory, relativePath(record.name));
  try {
    const metadata = await lstat(selected);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 512 * 1024 * 1024) throw new Error();
  } catch { throw new Error('package_offline_archive_unavailable'); }
  const hash = createHash('sha256'); for await (const bytes of createReadStream(selected)) hash.update(bytes);
  if (hash.digest('hex') !== record.sha256) throw new Error('package_offline_archive_changed');
}
export async function prepareElectronNotices({ extractedDirectory, outputDirectory, version, lock = defaultLock }) {
  const release = electronRelease(version, lock); const originals = [];
  for (const record of release.notices) {
    const bytes = await regularBytes(extractedDirectory, record.member); checkNotice(bytes, record); originals.push([record.output, bytes]);
  }
  await writeNotices(outputDirectory, release.notices, originals, release);
}
export async function verifyElectronNotices({ directory, version, lock = defaultLock }) {
  const release = electronRelease(version, lock); await verifyNotices(directory, release.notices, release);
}
