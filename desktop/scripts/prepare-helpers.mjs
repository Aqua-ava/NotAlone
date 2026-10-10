import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { acceptanceFlags, argumentsFor, failureReport, inspectRuntime } from './helper-runtime.mjs';

export function preparationArguments(values) {
  const index = values.indexOf('--destination');
  const destination = values[index + 1];
  if (index < 0 || index % 2 || typeof destination !== 'string' || !path.isAbsolute(destination)
    || /[\0\r\n]/.test(destination) || values.indexOf('--destination', index + 1) >= 0) throw new Error('helper_prepare_destination');
  return { ...argumentsFor([...values.slice(0, index), ...values.slice(index + 2)]), destination };
}

async function copyCheckedFile(source, destination, expected, deadline) {
  if (await realpath(source) !== source) throw new Error('helper_prepare_input_changed');
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let output;
  try {
    const before = await input.stat();
    if (!before.isFile() || before.size !== expected.bytes) throw new Error('helper_prepare_input_changed');
    output = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, expected.name === 'wechat-cli' ? 0o755 : 0o644);
    const hash = createHash('sha256'); const buffer = Buffer.alloc(1_048_576);
    let position = 0;
    while (position < before.size) {
      if (Date.now() >= deadline) throw new Error('helper_check_timeout');
      const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, before.size - position), position);
      if (!bytesRead) throw new Error('helper_prepare_input_changed');
      hash.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        const { bytesWritten } = await output.write(buffer, written, bytesRead - written, position + written);
        if (!bytesWritten) throw new Error('helper_prepare_input_changed');
        written += bytesWritten;
      }
      position += bytesRead;
    }
    const after = await input.stat();
    if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || hash.digest('hex') !== expected.sha256) throw new Error('helper_prepare_input_changed');
  } finally { await output?.close(); await input.close(); }
}

export async function prepareHelpers(input) {
  const root = await realpath(input.directory);
  const parent = await realpath(path.dirname(input.destination));
  const destination = path.join(parent, path.basename(input.destination));
  if (destination === root || destination.startsWith(`${root}${path.sep}`) || root.startsWith(`${destination}${path.sep}`)) throw new Error('helper_prepare_destination');
  const initial = await inspectRuntime(input);
  let owned;
  try {
    await mkdir(destination, { mode: 0o755 }); owned = await lstat(destination);
    const deadline = Date.now() + 60_000;
    for (const file of initial.files) {
      await mkdir(path.dirname(path.join(destination, file.name)), { recursive: true });
      await copyCheckedFile(path.join(root, file.name), path.join(destination, file.name), file, deadline);
    }
    const relocated = await inspectRuntime({ ...input, directory: destination });
    if (initial.files.length !== relocated.files.length || initial.files.some((file) => !relocated.files.some((copy) => copy.name === file.name && copy.sha256 === file.sha256))) throw new Error('helper_prepare_input_changed');
    const manifest = { schemaVersion: 1, versionDeclaration: input.version, sourceDeclaration: input.source,
      architecture: input.arch, files: relocated.files, ...acceptanceFlags };
    await writeFile(path.join(destination, 'manifest.json'), `${JSON.stringify(manifest)}\n`, { flag: 'wx', mode: 0o644 });
    return { ...relocated, state: 'prepared', ...acceptanceFlags };
  } catch (error) {
    if (owned) {
      const current = await lstat(destination).catch(() => undefined);
      if (current?.isDirectory() && current.dev === owned.dev && current.ino === owned.ino) await rm(destination, { recursive: true });
    }
    if (error.code === 'EEXIST') throw new Error('helper_prepare_destination');
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  let result;
  try { result = await prepareHelpers(preparationArguments(process.argv.slice(2))); }
  catch (error) { result = failureReport(error); process.exitCode = 2; }
  process.stdout.write(`${JSON.stringify({ ...result, ...acceptanceFlags })}\n`);
}
