import lockedSources from '../wechat-sources.lock.json' with { type: 'json' };
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

export const wechatDirectoryName = 'notalone-wechat';
export const wechatLockedComponents = Object.freeze([
  ...lockedSources.gitSources.map(({ name, version, source, commit }) => Object.freeze({ name, version, source, commit, role: name === 'wxkey' ? 'source-evidence' : 'runtime' })),
  ...lockedSources.archives.filter(item => ['wcdb','codelldb-lldb','cpython'].includes(item.name)).map(({ name, version, source, sha256 }) => Object.freeze({ name, version, source, sha256, role: 'runtime' })),
]);
export const wechatPaths = Object.freeze({ cli: 'bin/wechat-cli', wcdb: 'lib/libWCDB.dylib', lldb: 'debugger/bin/lldb', debugserver: 'debugger/bin/debugserver', python: 'debugger/bin/python3.12' });
export const wechatCapabilities = Object.freeze({ readOnlyCli: true, privilegedPreparation: false });
export const wechatAcceptance = Object.freeze({ realWechat: false, cleanMachine: false, systemAuthorization: false });
export async function hashWechatFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export async function wechatInventory(directory) {
  const input = await lstat(directory);
  if (!input.isDirectory() || input.isSymbolicLink() || (input.mode & 0o7022)) throw new Error('wechat_directory_invalid');
  const root = await realpath(directory); const files = []; let bytes = 0; let entries = 0;
  async function visit(relative = '') {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      const name = path.posix.join(relative, entry.name);
      if (++entries > 40_000 || name.split('/').length > 32) throw new Error('wechat_inventory_budget');
      if (/(?:^|\/)(?:\.git|\.env(?:\..*)?|\.DS_Store)$/.test(name)) throw new Error('wechat_forbidden_file');
      if (name === 'manifest.json') continue;
      const selected = path.join(root, name); const stat = await lstat(selected);
      if (stat.isSymbolicLink()) throw new Error('wechat_symlink_forbidden');
      if (stat.isDirectory()) { if (stat.mode & 0o7022) throw new Error('wechat_directory_invalid'); await visit(name); continue; }
      if (!stat.isFile() || stat.size > 512 * 1024 ** 2 || (stat.mode & 0o7022)) throw new Error('wechat_file_invalid');
      if (/(?:^|\/)(?:wxkey(?:\.exe)?|\.env(?:\..*)?|\.git|\.DS_Store)$/.test(name)) throw new Error('wechat_forbidden_file');
      bytes += stat.size;
      if (files.length >= 40_000 || bytes > 2 * 1024 ** 3) throw new Error('wechat_inventory_budget');
      files.push({ path: name, bytes: stat.size, mode: stat.mode & 0o777, sha256: await hashWechatFile(selected) });
    }
  }
  await visit(); return files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}
export async function inspectWechatComponents(directory) {
  const manifestFile = path.join(directory, 'manifest.json'); const stat = await lstat(manifestFile).catch(() => undefined);
  if (!stat) throw new Error('wechat_manifest_missing');
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 ** 2 || (stat.mode & 0o7022)) throw new Error('wechat_manifest_invalid');
  let manifest; try { manifest = JSON.parse(await readFile(manifestFile, 'utf8')); } catch { throw new Error('wechat_manifest_invalid'); }
  if (manifest.formatVersion !== 1 || manifest.architecture !== 'arm64' || manifest.runtimeKind !== wechatDirectoryName ||
    JSON.stringify(manifest.paths) !== JSON.stringify(wechatPaths) || JSON.stringify(manifest.capabilities) !== JSON.stringify(wechatCapabilities) ||
    JSON.stringify(manifest.acceptance) !== JSON.stringify(wechatAcceptance) || manifest.provenance?.signing !== 'ad-hoc-development' ||
    manifest.provenance?.developerId !== false || manifest.provenance?.notarized !== false || !/^[a-f0-9]{64}$/.test(manifest.provenance?.sourceLockSha256 || '') ||
    JSON.stringify(manifest.components) !== JSON.stringify(wechatLockedComponents)) throw new Error('wechat_manifest_invalid');
  const files = await wechatInventory(directory);
  if (JSON.stringify(files) !== JSON.stringify(manifest.files)) throw new Error('wechat_inventory_mismatch');
  for (const required of [...Object.values(wechatPaths), 'debugger/lib/liblldb.dylib', 'debugger/lib/libpython3.12.dylib', 'licenses/wechat-sources.lock.json', 'licenses/readonly-cli.patch']) {
    const file = files.find(item => item.path === required);
    if (!file || (Object.values(wechatPaths).includes(required) && required !== wechatPaths.wcdb && !(file.mode & 0o111))) throw new Error('wechat_component_missing');
  }
  const sourceFile = path.join(directory, 'licenses/wechat-sources.lock.json');
  if (await hashWechatFile(sourceFile) !== manifest.provenance.sourceLockSha256 || JSON.stringify(JSON.parse(await readFile(sourceFile, 'utf8'))) !== JSON.stringify(lockedSources)) throw new Error('wechat_source_lock_mismatch');
  if (await hashWechatFile(path.join(directory, 'licenses/readonly-cli.patch')) !== lockedSources.cliPatch.sha256) throw new Error('wechat_patch_hash');
  return manifest;
}
