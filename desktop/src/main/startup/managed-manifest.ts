import { constants } from 'node:fs';
import { access, open, readdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { managedLayout, minimumRuntimeComponents, requiredRuntimeFiles } from '../../../managed-runtime-contract.mjs';

export { managedLayout };
export type ManagedComponents = { root: string; python: string; project: string; postgres: string };

// 清单证明包内字节完整性；发行者身份仍由整个 App 的签名另行核验。
export async function verifyManagedComponents(resourcesDirectory: string | undefined, canContinue: () => boolean): Promise<ManagedComponents> {
  if (!resourcesDirectory || !path.isAbsolute(resourcesDirectory)) throw new Error('runtime_components_unavailable');
  const resources = await realpath(resourcesDirectory);
  const root = path.join(resources, 'notalone-runtime');
  if (await realpath(root) !== root) throw new Error('runtime_components_unavailable');
  const deadline = Date.now() + 60_000;
  const check = () => { if (!canContinue() || Date.now() >= deadline) throw new Error('runtime_components_unavailable'); };
  const file = await open(path.join(root, 'manifest.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let value: Record<string, unknown>;
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > 16_777_216) throw new Error();
    value = JSON.parse(await file.readFile('utf8'));
  } finally { await file.close(); }
  if (!value || value.formatVersion !== 1 || value.architecture !== process.arch || !Array.isArray(value.components)
    || value.components.length < minimumRuntimeComponents || value.components.length > 256 || !value.paths || typeof value.paths !== 'object'
    || Object.entries(managedLayout).some(([key, selected]) => (value.paths as Record<string, unknown>)[key] !== selected)
    || !Array.isArray(value.files) || !value.files.length || value.files.length > 50_000) throw new Error('runtime_components_unavailable');
  for (const component of value.components) {
    if (!component || typeof component !== 'object' || typeof component.name !== 'string' || typeof component.version !== 'string'
      || typeof component.source !== 'string' || !/^(https:\/\/|repository:)/.test(component.source)
      || typeof component.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(component.sha256)) throw new Error('runtime_components_unavailable');
  }
  const names = new Set<string>(); let totalBytes = 0;
  for (const entry of value.files) {
    check();
    if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string' || !validRelativePath(entry.path)
      || entry.path === 'manifest.json' || names.has(entry.path) || typeof entry.sha256 !== 'string'
      || !/^[a-f0-9]{64}$/.test(entry.sha256) || (entry.executable !== undefined && typeof entry.executable !== 'boolean')) throw new Error('runtime_components_unavailable');
    names.add(entry.path);
    const selected = path.join(root, entry.path);
    const resolved = await realpath(selected);
    if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error('runtime_components_unavailable');
    const input = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await input.stat();
      totalBytes += before.size;
      if (!before.isFile() || before.size > 536_870_912 || totalBytes > 6_442_450_944) throw new Error('runtime_components_unavailable');
      const hash = createHash('sha256'); const buffer = Buffer.alloc(1_048_576); let position = 0;
      while (position < before.size) {
        check();
        const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, before.size - position), position);
        if (!bytesRead) throw new Error('runtime_components_unavailable');
        hash.update(buffer.subarray(0, bytesRead)); position += bytesRead;
      }
      const after = await input.stat();
      if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
        || hash.digest('hex') !== entry.sha256) throw new Error('runtime_components_unavailable');
      if (entry.executable) await access(resolved, constants.X_OK);
    } finally { await input.close(); }
  }
  for (const required of requiredRuntimeFiles) {
    if (!names.has(required)) throw new Error('runtime_components_unavailable');
    if (required.endsWith('.py')) continue;
    await access(path.join(root, required), constants.X_OK);
  }
  // 未登记的 .pth、共享库或模块也可能被解释器载入，因此核验完整文件库存。
  const visit = async (directory: string): Promise<void> => {
    check();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const selected = path.join(directory, entry.name);
      const relative = path.relative(root, selected).split(path.sep).join('/');
      if (entry.isDirectory()) await visit(selected);
      else if (relative !== 'manifest.json' && !names.has(relative)) throw new Error('runtime_components_unavailable');
    }
  };
  await visit(root);
  return { root, python: path.join(root, managedLayout.python), project: path.join(root, managedLayout.project), postgres: path.join(root, managedLayout.postgres) };
}

function validRelativePath(value: string): boolean {
  return value.length <= 1024 && !path.isAbsolute(value) && !/[\\\0\r\n]/.test(value)
    && value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}
