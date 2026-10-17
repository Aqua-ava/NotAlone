import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { managedLayout, minimumRuntimeComponents, requiredRuntimeFiles } from '../managed-runtime-contract.mjs';
export const runtimeDirectoryName = 'notalone-runtime';
export async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export async function runtimeInventory(directory) {
  const root = await realpath(directory); const files = []; let bytes = 0;
  async function visit(relative = '') {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      const name = path.posix.join(relative, entry.name);
      if (name === 'manifest.json') continue;
      const selected = path.join(root, name);
      if (entry.isDirectory()) { await visit(name); continue; }
      if (!entry.isFile() && !entry.isSymbolicLink()) throw new Error('runtime_file_kind');
      const resolved = await realpath(selected);
      if (!resolved.startsWith(root + path.sep)) throw new Error('runtime_symlink_escape');
      const stat = await lstat(resolved);
      if (!stat.isFile() || stat.size > 512 * 1024 * 1024) throw new Error('runtime_file_size');
      bytes += stat.size;
      if (files.length >= 50_000 || bytes > 6 * 1024 ** 3) throw new Error('runtime_inventory_budget');
      if (/\.(?:egg-link)$|(?:^|\/)__editable__|(?:^|\/)direct_url\.json$|(?:^|\/)\.env(?:\.|$)/.test(name)) throw new Error('runtime_developer_configuration');
      if (name.endsWith('.pth')) {
        const content = await readFile(selected, 'utf8');
        // 不允许pth把开发路径或启动代码引入受管解释器。
        if (content.split(/\r?\n/).some((line) => line.trim() && !line.startsWith('#') &&
          (line.startsWith('import ') || path.isAbsolute(line) || line.includes('..')))) throw new Error('runtime_unsafe_pth');
      }
      files.push({ path: name, sha256: await hashFile(selected), ...(stat.mode & 0o111 ? { executable: true } : {}) });
    }
  }
  await visit(); return files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}
export async function inspectManagedRuntime(directory) {
  let raw;
  try { raw = await readFile(path.join(directory, 'manifest.json'), 'utf8'); } catch { throw new Error('runtime_manifest_missing'); }
  if (Buffer.byteLength(raw) > 16 * 1024 * 1024) throw new Error('runtime_manifest_budget');
  const manifest = JSON.parse(raw);
  if (manifest.formatVersion !== 1 || manifest.architecture !== 'arm64' || !Array.isArray(manifest.components) ||
    manifest.components.length < minimumRuntimeComponents || manifest.components.length > 256 || manifest.components.some((item) =>
      typeof item.name !== 'string' || typeof item.version !== 'string' || !/^(https:\/\/|repository:)/.test(item.source) || !/^[a-f0-9]{64}$/.test(item.sha256)) ||
    JSON.stringify(manifest.paths) !== JSON.stringify(managedLayout)) throw new Error('runtime_manifest_invalid');
  const actual = await runtimeInventory(directory);
  if (!Array.isArray(manifest.files) || JSON.stringify(actual) !== JSON.stringify(manifest.files)) throw new Error('runtime_inventory_mismatch');
  for (const required of requiredRuntimeFiles) {
    if (!actual.some((file) => file.path === required)) throw new Error('runtime_component_missing');
    if (!required.endsWith('.py') && !actual.some((file) => file.path === required && file.executable)) throw new Error('runtime_component_not_executable');
  }
  return manifest;
}
