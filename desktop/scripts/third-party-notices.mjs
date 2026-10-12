import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceDirectory = fileURLToPath(new URL('../third-party-notices/wcdb-v2.1.15', import.meta.url));
const names = ['WCDB-LICENSE.txt', 'SQLCipher-LICENSE.txt', 'ZSTD-LICENSE.txt', 'ZSTD-COPYING.txt',
  'OpenSSL-LICENSE.txt', 'wechat-cli-LICENSE.txt', 'wechat-cli-THIRD-PARTY-NOTICES.md', 'README.md'];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const failure = (kind) => new Error(`third_party_notice_${kind}`);

async function directoryIdentity(directory) {
  try {
    const identity = await lstat(directory);
    if (!identity.isDirectory() || identity.isSymbolicLink()) throw failure('invalid');
    return identity;
  } catch { throw failure('invalid'); }
}

async function readRegularFile(directory, name) {
  let handle;
  try {
    handle = await open(path.join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const identity = await handle.stat();
    if (!identity.isFile() || identity.size > 512 * 1024) throw failure('invalid');
    const bytes = Buffer.alloc(identity.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) throw failure('changed');
      offset += result.bytesRead;
    }
    const current = await lstat(path.join(directory, name));
    const final = await handle.stat();
    if (current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino
      || final.size !== identity.size || final.mtimeMs !== identity.mtimeMs) throw failure('changed');
    return bytes;
  } catch (error) {
    if (error.message === 'third_party_notice_changed') throw error;
    throw failure('invalid');
  } finally { await handle?.close(); }
}

async function readExpectedFiles(files, directory) {
  const identity = await directoryIdentity(directory);
  directory = await realpath(directory);
  const entries = await readdir(directory);
  if (entries.length !== files.length || entries.some((name) => !files.some((file) => file.name === name))) throw failure('changed');
  const result = [];
  for (const file of files) {
    const bytes = await readRegularFile(directory, file.name);
    if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) throw failure('changed');
    result.push({ ...file, content: bytes });
  }
  const current = await directoryIdentity(directory);
  if (current.dev !== identity.dev || current.ino !== identity.ino) throw failure('changed');
  return result;
}

export async function verifyThirdPartyNotices(prepared, directory) {
  await readExpectedFiles(prepared.files, directory);
}

export async function prepareThirdPartyNotices(runtime, destination) {
  await directoryIdentity(sourceDirectory);
  const manifestBytes = await readRegularFile(sourceDirectory, 'manifest.json');
  let manifest;
  try { manifest = JSON.parse(manifestBytes.toString('utf8')); } catch { throw failure('invalid'); }
  if (manifest.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(manifest.librarySha256)
    || !/^[a-f0-9]{64}$/.test(manifest.publisherRelease?.cliSha256)
    || manifest.licenseMaterialsCollected !== true || manifest.exactBuildSourceVerified !== false
    || manifest.binaryLicenseCoverageVerified !== false || !Array.isArray(manifest.files)
    || manifest.files.length !== names.length || manifest.files.some((file) => !names.includes(file.name)
      || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > 512 * 1024 || !/^[a-f0-9]{64}$/.test(file.sha256))
    || new Set(manifest.files.map((file) => file.name)).size !== names.length) throw failure('invalid');
  if (runtime.librarySha256 !== manifest.librarySha256 || runtime.cliSha256 !== manifest.publisherRelease.cliSha256) return undefined;
  const files = [...manifest.files, { name: 'manifest.json', bytes: manifestBytes.length, sha256: sha256(manifestBytes) }];
  const contents = await readExpectedFiles(files, sourceDirectory);
  let owned;
  try {
    destination = path.join(await realpath(path.dirname(destination)), path.basename(destination));
    // 独占创建，只清理本次拥有的目录，不覆盖调用者已有资料。
    try { await mkdir(destination); owned = await directoryIdentity(destination); }
    catch { throw failure('destination'); }
    for (const file of contents) await writeFile(path.join(destination, file.name), file.content, { flag: 'wx' });
    const prepared = { files, licenseMaterialsCollected: true, exactBuildSourceVerified: false, binaryLicenseCoverageVerified: false };
    await verifyThirdPartyNotices(prepared, destination);
    return prepared;
  } catch (error) {
    if (owned) {
      const current = await lstat(destination).catch(() => undefined);
      if (current?.isDirectory() && !current.isSymbolicLink() && current.dev === owned.dev && current.ino === owned.ino) await rm(destination, { recursive: true });
    }
    if (['third_party_notice_invalid', 'third_party_notice_changed', 'third_party_notice_destination'].includes(error.message)) throw error;
    throw failure('destination');
  }
}
