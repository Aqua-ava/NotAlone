import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const kit = path.dirname(fileURLToPath(import.meta.url));
async function hash(file) { const value = createHash('sha256'); for await (const chunk of createReadStream(file)) value.update(chunk); return value.digest('hex'); }
async function inventory(relative = '') {
  const files = [];
  for (const entry of await readdir(path.join(kit, relative), { withFileTypes: true })) {
    const name = path.posix.join(relative, entry.name);
    if (name === 'kit-inventory.json') continue;
    if (entry.isDirectory()) files.push(...await inventory(name));
    else if (entry.isFile()) files.push({ path: name, sha256: await hash(path.join(kit, name)), bytes: (await lstat(path.join(kit, name))).size });
    else throw new Error('replacement_kit_file_kind');
  }
  return files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}
const manifest = JSON.parse(await readFile(path.join(kit, 'kit-inventory.json'), 'utf8'));
if (manifest.formatVersion !== 1 || JSON.stringify(manifest.files) !== JSON.stringify(await inventory())) throw new Error('replacement_kit_inventory_mismatch');
const [command, ...args] = process.argv.slice(2);
if (command === 'check' && !args.length) console.log(`工具包完整性通过：${manifest.files.length + 1}个文件。`);
else {
  let script, values = args;
  if (command === 'rebuild') {
    if (![6, 8].includes(args.length) || (args.length === 8 && args[6] !== '--patch-file') || ['--runtime-directory', '--output-directory', '--work-directory'].some((key, i) => args[i * 2] !== key)) throw new Error('replacement_kit_rebuild_arguments');
    const lock = JSON.parse(await readFile(path.join(kit, 'scripts/runtime/attribution-sources.lock.json'), 'utf8'));
    script = 'rebuild-psycopg-runtime.mjs';
    values = ['--source-archive', path.join(args[1], 'licenses/attribution/sources', lock.sources.find((item) => item.name === 'psycopg-upstream').filename), ...args.slice(0, 6), '--source-cache', path.join(kit, 'inputs'), ...args.slice(6)];
  } else if (command === 'install') script = 'install-runtime-copy.mjs';
  else if (command === 'verify') script = 'verify-runtime.mjs';
  else throw new Error('replacement_kit_command:check|rebuild|install|verify');
  const child = spawn(process.execPath, [path.join(kit, 'scripts', script), ...values], { stdio: 'inherit', env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8' } });
  child.once('error', (error) => { console.error(error); process.exitCode = 1; });
  child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
}
