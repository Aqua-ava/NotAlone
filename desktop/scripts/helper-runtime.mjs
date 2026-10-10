import path from 'node:path';
import { constants } from 'node:fs';
import { access, open, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const inside = (root, file) => file.startsWith(`${root}${path.sep}`);
const identity = (metadata) => `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeMs}:${metadata.ctimeMs}`;

export function requireUnchangedFiles(expected, actual) {
  const copies = new Map(actual.map((file) => [file.name, file.sha256]));
  if (expected.length !== actual.length || copies.size !== actual.length
    || expected.some((file) => copies.get(file.name) !== file.sha256)) throw new Error('helper_prepare_input_changed');
}

async function readBinary(file, deadline) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 4 || metadata.size > 268_435_456) throw new Error('helper_check_input_invalid');
    const header = Buffer.alloc(4); await handle.read(header, 0, 4, 0);
    if (!['cffaedfe', 'feedfacf', 'cefaedfe', 'feedface', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(header.toString('hex'))) throw new Error('helper_check_not_macho');
    const hash = createHash('sha256'); const buffer = Buffer.alloc(1_048_576);
    let position = 0;
    while (position < metadata.size) {
      if (Date.now() >= deadline) throw new Error('helper_check_timeout');
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, metadata.size - position), position);
      if (!bytesRead) throw new Error('helper_check_input_changed');
      hash.update(buffer.subarray(0, bytesRead)); position += bytesRead;
    }
    if (identity(await handle.stat()) !== identity(metadata)) throw new Error('helper_check_input_changed');
    return { sha256: hash.digest('hex'), identity: identity(metadata), bytes: metadata.size };
  } finally { await handle.close(); }
}

async function tool(program, values, code, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('helper_check_timeout');
  try { return (await run(program, values, { timeout: Math.min(5000, remaining), maxBuffer: 1_048_576, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } })).stdout; }
  catch { throw new Error(code); }
}

function loadCommands(text) {
  const rpaths = []; const dependencies = [];
  for (const block of text.split(/Load command \d+\r?\n/).slice(1)) {
    if (/\bcmd LC_RPATH\b/.test(block)) {
      const value = block.match(/^\s+path (.+) \(offset \d+\)$/m)?.[1];
      if (!value) throw new Error('helper_check_dependency_unresolved');
      rpaths.push(value);
    } else if (/\bcmd LC_(?:LOAD|LOAD_WEAK|REEXPORT|LAZY_LOAD|LOAD_UPWARD)_DYLIB\b/.test(block)) {
      const value = block.match(/^\s+name (.+) \(offset \d+\)$/m)?.[1];
      if (!value) throw new Error('helper_check_dependency_unresolved');
      dependencies.push(value);
    }
  }
  return { rpaths, dependencies };
}

function localPath(value, loader, executable) {
  for (const [prefix, directory] of [['@loader_path', loader], ['@executable_path', executable]]) {
    if (value === prefix || value.startsWith(`${prefix}/`)) return path.resolve(directory, value.slice(prefix.length + 1));
  }
  return path.isAbsolute(value) ? path.resolve(value) : null;
}

export async function inspectRuntime(input) {
  if (process.platform !== 'darwin') throw new Error('helper_check_unavailable');
  const root = await realpath(input.directory);
  if (!(await stat(root)).isDirectory()) throw new Error('helper_check_input_invalid');
  const deadline = Date.now() + 60_000;
  const files = []; const visited = new Set();
  async function inspect(file, inheritedRpaths = []) {
    if (visited.has(file)) return;
    if (!inside(root, file) || await realpath(file) !== file || visited.size >= 64) throw new Error('helper_check_input_invalid');
    visited.add(file);
    const snapshot = await readBinary(file, deadline);
    const arches = (await tool('/usr/bin/lipo', ['-archs', file], 'helper_check_not_macho', deadline)).trim().split(/\s+/);
    if (!arches.includes(input.arch)) throw new Error('helper_check_architecture');
    const header = await tool('/usr/bin/otool', ['-arch', input.arch, '-hv', file], 'helper_check_binary_type', deadline);
    const type = file === path.join(root, 'wechat-cli') ? 'EXECUTE' : 'DYLIB';
    if (!new RegExp(`\\b${type}\\b`).test(header.split('\n').slice(1).join('\n'))) throw new Error('helper_check_binary_type');
    await tool('/usr/bin/codesign', ['--verify', '--strict', file], 'helper_check_signature', deadline);
    const commands = loadCommands(await tool('/usr/bin/otool', ['-arch', input.arch, '-l', file], 'helper_check_dependency_unresolved', deadline));
    const rpaths = [...commands.rpaths.map((value) => localPath(value, path.dirname(file), root)), ...inheritedRpaths];
    for (const dependency of commands.dependencies) {
      if (dependency === path.normalize(dependency) && (dependency.startsWith('/usr/lib/') || dependency.startsWith('/System/Library/'))) continue;
      // 不跳过更早的未知搜索路径：实际装载可能优先命中目录外副本。
      if (dependency.startsWith('@rpath/') && rpaths.some((directory) => !directory || (directory !== root && !inside(root, directory)))) throw new Error('helper_check_dependency_unresolved');
      const candidates = dependency.startsWith('@rpath/')
        ? rpaths.map((directory) => path.resolve(directory, dependency.slice(7)))
        : [localPath(dependency, path.dirname(file), root)];
      let resolved;
      for (const candidate of candidates) {
        if (!candidate || !inside(root, candidate)) throw new Error('helper_check_dependency_unresolved');
        try {
          if (await realpath(candidate) !== candidate) throw new Error('helper_check_dependency_unresolved');
          resolved = candidate; break;
        } catch (error) {
          if (error.code !== 'ENOENT') throw new Error('helper_check_dependency_unresolved');
        }
      }
      if (!resolved) throw new Error('helper_check_dependency_unresolved');
      await inspect(resolved, rpaths);
    }
    const final = await readBinary(file, deadline);
    if (snapshot.sha256 !== final.sha256 || snapshot.identity !== final.identity) throw new Error('helper_check_input_changed');
    files.push({ name: path.relative(root, file), sha256: snapshot.sha256, bytes: snapshot.bytes, architectures: arches, signature: 'verified' });
  }
  await access(path.join(root, 'wechat-cli'), constants.X_OK);
  await inspect(path.join(root, 'wechat-cli'));
  // WCDB可由程序动态加载，必须独立检查，不能只依赖Mach-O的链接表。
  await inspect(path.join(root, 'libWCDB.dylib'));
  return { state: 'static_checks_passed', versionDeclaration: input.version, architecture: input.arch, files };
}

export function argumentsFor(values) {
  const fields = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index]; const value = values[index + 1];
    if (!['--directory', '--version', '--source', '--arch'].includes(key) || key in fields
      || typeof value !== 'string' || !value || /[\0\r\n]/.test(value)) throw new Error('helper_check_arguments');
    fields[key] = value;
  }
  if (!path.isAbsolute(fields['--directory'] ?? '') || !/^[a-zA-Z0-9._+-]{1,64}$/.test(fields['--version'] ?? '')) throw new Error('helper_check_arguments');
  let source;
  try { source = new URL(fields['--source']); } catch { throw new Error('helper_check_arguments'); }
  if (source.protocol !== 'https:' || source.username || source.password || source.search || source.hash) throw new Error('helper_check_arguments');
  const arch = fields['--arch'] ?? (process.arch === 'x64' ? 'x86_64' : process.arch);
  if (!['arm64', 'x86_64'].includes(arch)) throw new Error('helper_check_arguments');
  return { directory: fields['--directory'], version: fields['--version'], source: source.href, arch };
}

export function failureReport(error) {
  const codes = ['helper_check_arguments', 'helper_check_not_macho', 'helper_check_input_invalid', 'helper_check_input_changed',
    'helper_check_architecture', 'helper_check_binary_type', 'helper_check_signature', 'helper_check_dependency_unresolved', 'helper_check_timeout',
    'helper_prepare_destination', 'helper_prepare_input_changed'];
  return { state: 'blocked', code: codes.includes(error.message) ? error.message : error.code === 'ENOENT' ? 'helper_check_missing_file' : 'helper_check_unavailable' };
}

export const acceptanceFlags = { helperExecuted: false, provenanceVerified: false, runtimeValidated: false, nativeAcceptance: false };
