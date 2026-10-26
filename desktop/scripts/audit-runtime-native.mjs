import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { runtimeInventory } from './managed-runtime.mjs';

export async function auditNative(directory, execute) {
  const root = await realpath(directory), audit = [];
  for (const item of await runtimeInventory(root)) {
    const file = path.join(root, item.path), handle = await open(file, 'r');
    const header = Buffer.alloc(4);
    try { await handle.read(header, 0, 4, 0); } finally { await handle.close(); }
    if (!['cffaedfe', 'feedfacf', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(header.toString('hex'))) continue;
    await execute('/usr/bin/lipo', [file, '-verify_arch', 'arm64']);
    const dependencies = (await execute('/usr/bin/otool', ['-L', file])).stdout.split('\n').map((line) => /^\s+([^ ]+) \(compatibility/.exec(line)?.[1]).filter(Boolean);
    const identifiers = (await execute('/usr/bin/otool', ['-D', file])).stdout.split('\n').map((line) => line.trim()).filter((line) => line && !line.endsWith(':'));
    for (const dependency of dependencies) {
      if (identifiers.includes(dependency) || dependency.startsWith('/usr/lib/') || dependency.startsWith('/System/Library/')) continue;
      let candidates;
      if (dependency.startsWith('@loader_path/')) candidates = [path.resolve(path.dirname(file), dependency.slice(13))];
      else if (dependency.startsWith('@executable_path/')) candidates = [path.resolve(root, 'postgres/bin', dependency.slice(17))];
      else if (dependency.startsWith('@rpath/')) candidates = [path.join(root, 'postgres/lib', dependency.slice(7)), path.join(path.dirname(file), dependency.slice(7))];
      else throw new Error(`runtime_native_external_dependency:${dependency}`);
      const found = (await Promise.all(candidates.map((candidate) => realpath(candidate).catch(() => undefined)))).filter(Boolean);
      if (!found.some((candidate) => candidate.startsWith(root + path.sep))) throw new Error(`runtime_native_dependency_escape:${dependency}`);
    }
    await execute('/usr/bin/codesign', ['--verify', '--strict', file]);
    audit.push({ path: item.path, dependencies });
  }
  return audit;
}

