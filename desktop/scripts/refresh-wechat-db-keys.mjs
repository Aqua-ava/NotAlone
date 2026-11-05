#!/usr/bin/env node
// 补取微信数据库密钥的维护脚本（由用户本人在终端运行；流程见 docs/guides/wechat-db-key-refresh.md）。
// 只把密钥表里缺失的盐补进 ~/.config/wxcli/config.json：不覆盖、不删除已有密钥，不写入图片密钥，
// 不打印、不记录任何密钥值。产品运行时不调用本脚本。
import { spawn, execFile } from 'node:child_process';
import { constants, existsSync, renameSync } from 'node:fs';
import { copyFile, open, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const saltPattern = /^[0-9a-f]{32}$/;
const keyPattern = /^[0-9a-f]{64}$/;
const plainSqlite = Buffer.from('SQLite format 3\0');
const defaultDatabase = 'message/message_resource.db';
const confirmPhrase = '确认补取';
const fail = code => { throw new Error(code); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** 去掉输出里任何形似密钥或盐的长十六进制串，以及含密钥字段的整行。 */
export function redact(text) {
  return String(text).split('\n').filter(line => !/"(?:key|results|image_key|xor_key)"/.test(line))
    .map(line => line.replace(/[0-9a-fA-F]{16,}/g, '<已隐藏>')).join('\n');
}

export function defaultPaths(home = homedir()) {
  return {
    config: path.join(home, '.config/wxcli/config.json'),
    wxkey: path.join(home, 'Library/Application Support/NotAloneDesktop/wechat-tool/bin/wxkey'),
    shadowApp: path.join(home, 'Library/Application Support/wx-mcp/WeChat-shadow.app'),
  };
}

async function readPrivateJson(file) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 2 || info.size > 1024 * 1024 || (info.mode & 0o077) !== 0
      || typeof process.getuid === 'function' && info.uid !== process.getuid()) fail('wechat_key_config_invalid');
    return JSON.parse(await handle.readFile('utf8'));
  } finally { await handle.close(); }
}

function validateConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config) || typeof config.db_root !== 'string'
    || !path.isAbsolute(config.db_root) || path.normalize(config.db_root) !== config.db_root
    || !config.keys || typeof config.keys !== 'object' || Array.isArray(config.keys)) fail('wechat_key_config_invalid');
  return config;
}

export async function loadKeyConfig(file) { return validateConfig(await readPrivateJson(file)); }

async function headerSalt(file) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 4096) return null;
    const header = Buffer.alloc(16);
    const { bytesRead } = await handle.read(header, 0, 16, 0);
    return bytesRead === 16 && !header.equals(plainSqlite) ? header.toString('hex') : null;
  } finally { await handle.close(); }
}

async function* walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile() && entry.name.endsWith('.db')) yield full;
  }
}

/** 逐库比对文件头盐与密钥表的键名；只返回库的相对名，不含任何密钥。 */
export async function databaseCoverage(config) {
  const root = path.join(config.db_root, 'db_storage');
  const salts = new Set(Object.keys(config.keys).map(salt => salt.toLowerCase()));
  const covered = [], missing = [];
  for await (const file of walk(root)) {
    const salt = await headerSalt(file).catch(() => null);
    if (!salt) continue;
    (salts.has(salt) ? covered : missing).push(path.relative(root, file));
  }
  return { covered: covered.sort(), missing: missing.sort() };
}

/** 纯函数：把新配置里“旧配置没有的盐”并入旧配置，其余原样保留。 */
export function mergeMissingKeys(current, fresh) {
  validateConfig(current); validateConfig(fresh);
  if (fresh.db_root !== current.db_root || fresh.wxid !== current.wxid) fail('wechat_key_account_mismatch');
  const merged = { ...current, keys: { ...current.keys } };
  const known = new Set(Object.keys(current.keys).map(salt => salt.toLowerCase()));
  let added = 0;
  for (const [salt, key] of Object.entries(fresh.keys)) {
    if (known.has(salt.toLowerCase())) continue;
    if (!saltPattern.test(salt) || typeof key !== 'string' || !keyPattern.test(key)) fail('wechat_key_entry_invalid');
    merged.keys[salt] = key; added++;
  }
  const epoch = Math.max(Number(current.key_epoch) || 0, Number(fresh.key_epoch) || 0);
  if (epoch > 0) merged.key_epoch = epoch;
  return { merged, added };
}

async function writePrivateAtomic(file, value) {
  const temporary = `${file}.merge-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await rename(temporary, file);
}

export async function backupConfig(file, now = new Date()) {
  const day = now.toISOString().slice(0, 10).replaceAll('-', '');
  for (let index = 0; index < 100; index++) {
    const target = `${file}.backup-${day}${index ? `-${index}` : ''}`;
    if (existsSync(target)) continue;
    await copyFile(file, target, constants.COPYFILE_EXCL);
    return target;
  }
  return fail('wechat_key_backup_exists');
}

const asidePath = file => `${file}.aside-refresh`;

/** 上次运行被中断且留下挪开的配置时，没有当前配置就自动放回；否则保留现场并要求人工处理。 */
export async function recoverInterrupted(file) {
  const aside = asidePath(file);
  if (!existsSync(aside)) return 'none';
  if (existsSync(file)) return fail('wechat_key_aside_present');
  await rename(aside, file);
  return 'restored';
}

/**
 * 把真实配置挪开，运行 task（wxkey setup 会整份写默认路径），读出它写下的新配置后无论成败都放回旧配置。
 * 新配置只保留在内存里，随即从磁盘删除。
 */
export async function withConfigAside(file, task) {
  const aside = asidePath(file);
  if (existsSync(aside)) fail('wechat_key_aside_present');
  const original = await readFile(file);
  await rename(file, aside);
  const restoreSync = () => { try { if (!existsSync(file)) renameSync(aside, file); } catch { /* 留下的挪开文件由下次运行恢复 */ } };
  const onSignal = signal => { restoreSync(); process.exit(signal === 'SIGINT' ? 130 : 143); };
  const handlers = ['SIGINT', 'SIGTERM'].map(signal => { const handler = () => onSignal(signal); process.once(signal, handler); return [signal, handler]; });
  let fresh = null, failure;
  try {
    await task();
    if (existsSync(file)) { try { fresh = await readPrivateJson(file); } catch { fresh = null; } }
  } catch (error) { failure = error; }
  finally {
    if (existsSync(file)) await unlink(file).catch(() => {});
    await rename(aside, file);
    for (const [signal, handler] of handlers) process.off(signal, handler);
    const restored = await readFile(file);
    if (!restored.equals(original)) fail('wechat_key_restore_mismatch');
  }
  if (failure) throw failure;
  return fresh;
}

export async function waitForDatabaseOpen(pid, name, { lsof, timeoutMs = 600_000, intervalMs = 3_000, sleeper = sleep, now = Date.now, alive = () => true } = {}) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (!alive(pid)) return 'exited';
    if ((await lsof(pid)).split('\n').some(line => line.endsWith(name))) return 'open';
    await sleeper(intervalMs);
  }
  return 'timeout';
}

const processAlive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

const realDeps = paths => ({
  appStopped: async () => {
    const script = fileURLToPath(new URL('./development-status.mjs', import.meta.url));
    try { return JSON.parse((await run('node', [script], { timeout: 20_000 })).stdout.trim().split('\n').pop()).mode === 'stopped'; }
    catch { return false; }
  },
  wechatRunning: async () => { try { return (await run('pgrep', ['-x', 'WeChat'])).stdout.trim().length > 0; } catch { return false; } },
  launchShadow: executable => {
    const child = spawn(executable, [], { detached: true, stdio: 'ignore' });
    child.unref();
    if (!child.pid) fail('wechat_key_shadow_launch_failed');
    return child.pid;
  },
  lsof: async pid => { try { return (await run('lsof', ['-p', String(pid)], { maxBuffer: 8 * 1024 ** 2, timeout: 20_000 })).stdout; } catch { return ''; } },
  alive: processAlive,
  // setup 的标准输出含全部密钥，直接丢弃；标准错误经脱敏后实时转给用户，标准输入保留以便输入管理员密码。
  runWxkey: (args, timeoutMs) => new Promise(resolve => {
    const child = spawn(paths.wxkey, args, { stdio: ['inherit', 'ignore', 'pipe'] });
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    let tail = '';
    child.stderr.on('data', chunk => { const text = redact(chunk.toString()); tail = (tail + text).slice(-4000); process.stderr.write(text); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, tail }); });
    child.on('error', () => { clearTimeout(timer); resolve({ code: -1, tail }); });
  }),
  confirm: async text => {
    if (!process.stdin.isTTY) return false;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try { return (await rl.question(text)).trim() === confirmPhrase; } finally { rl.close(); }
  },
  say: line => console.log(line),
  sleeper: sleep,
});

/**
 * @param {{check?:boolean, databases?:string[], paths?:object}} options
 * 退出状态：0 无需补取或补取成功；2 `--check` 发现缺密钥；其余为失败（已回滚配置）。
 */
export async function refreshWechatDatabaseKeys(options = {}, injected = {}) {
  const paths = { ...defaultPaths(), ...options.paths };
  const deps = { ...realDeps(paths), ...injected };
  const targets = options.databases?.length ? options.databases : [defaultDatabase];
  const recovered = await recoverInterrupted(paths.config);
  if (recovered === 'restored') deps.say('已把上次中断时挪开的配置放回原位。');
  const config = await loadKeyConfig(paths.config);
  const before = await databaseCoverage(config);
  const missing = targets.filter(name => before.missing.includes(name));
  deps.say(`密钥表共 ${Object.keys(config.keys).length} 把；缺密钥的库：${before.missing.length ? before.missing.join('、') : '无'}`);
  if (!missing.length) { deps.say('目标库已有密钥，无需补取。'); return { status: 'covered', exitCode: 0 }; }
  if (options.check) { deps.say(`目标库缺密钥：${missing.join('、')}`); return { status: 'missing', exitCode: 2 }; }

  deps.say(['', '即将补取微信数据库密钥，过程中会：', '  1. 把真实配置备份后临时挪开，结束后无论成败都放回；',
    '  2. 启动微信的“影子副本”，请你在里面扫码登录并打开一个有图片的聊天；',
    '  3. 用 wxkey 以管理员权限扫描影子副本内存（首次需你本人输入管理员密码）；',
    '  4. 只把缺失的盐的密钥合并进配置，不改已有密钥，不打印任何密钥值。', ''].join('\n'));
  if (!await deps.confirm(`确认请输入“${confirmPhrase}”：`)) { deps.say('未确认，没有做任何改动。'); return { status: 'declined', exitCode: 1 }; }

  if (!await deps.appStopped()) fail('wechat_key_app_running');
  if (await deps.wechatRunning()) fail('wechat_key_wechat_running');
  if (!existsSync(paths.wxkey)) fail('wechat_key_tool_missing');
  const backup = await backupConfig(paths.config);
  deps.say(`配置已备份：${backup}`);
  const root = config.db_root;

  if (!existsSync(paths.shadowApp)) {
    deps.say('尚无影子微信副本，先让 wxkey 生成（预期会因未登录而失败，副本会留下）……');
    const first = await withConfigAside(paths.config, () => deps.runWxkey(['bootstrap', '--root', root], 180_000));
    if (first) {
      // 若这一次恰好已经取到密钥（用户已登录影子微信），照样只合并缺失的盐。
      const { merged, added } = mergeMissingKeys(await loadKeyConfig(paths.config), first);
      if (added > 0) await writePrivateAtomic(paths.config, merged);
      if (!(await databaseCoverage(merged)).missing.some(name => targets.includes(name))) {
        deps.say(`新增 ${added} 把，目标库已有密钥。`);
        return { status: 'refreshed', exitCode: 0, added, backup };
      }
    }
    if (!existsSync(paths.shadowApp)) fail('wechat_key_shadow_missing');
  }
  const pid = deps.launchShadow(path.join(paths.shadowApp, 'Contents/MacOS/WeChat'));
  deps.say(`影子微信已启动（pid ${pid}）。请在它的窗口里扫码登录，并打开一个有图片的聊天、多滚动几下……`);
  const opened = await waitForDatabaseOpen(pid, path.basename(missing[0]), { lsof: deps.lsof, sleeper: deps.sleeper, alive: deps.alive, timeoutMs: options.waitMs ?? 600_000 });
  if (opened !== 'open') fail(opened === 'exited' ? 'wechat_key_shadow_exited' : 'wechat_key_login_timeout');
  deps.say('已检测到目标库被打开，开始扫描……');

  let result;
  const fresh = await withConfigAside(paths.config, async () => { result = await deps.runWxkey(['setup', '--pid', String(pid), '--root', root], 200_000); });
  if (!fresh) fail('wechat_key_setup_failed');
  const { merged, added } = mergeMissingKeys(await loadKeyConfig(paths.config), fresh);
  if (added > 0) await writePrivateAtomic(paths.config, merged);
  const after = await databaseCoverage(merged);
  const stillMissing = targets.filter(name => after.missing.includes(name));
  deps.say(`新增 ${added} 把；密钥表现共 ${Object.keys(merged.keys).length} 把；仍缺密钥的库：${after.missing.length ? after.missing.join('、') : '无'}`);
  if (stillMissing.length) fail('wechat_key_target_still_missing');
  deps.say('完成。请退出影子微信（Cmd+Q），再从应用程序打开正常微信；配置备份已保留。');
  return { status: 'refreshed', exitCode: 0, added, backup, setupExit: result?.code };
}

function parseArguments(args) {
  const options = { databases: [] };
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--check') options.check = true;
    else if (args[index] === '--database' && args[index + 1]) options.databases.push(args[++index]);
    else fail('wechat_key_arguments_invalid');
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await refreshWechatDatabaseKeys(parseArguments(process.argv.slice(2)));
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(redact(error.message ?? 'wechat_key_refresh_failed'));
    process.exitCode = 1;
  }
}
