import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';

const resourceDatabase = 'db_storage/message/message_resource.db';
const configByteLimit = 1024 * 1024;
const plainSqliteHeader = Buffer.from('SQLite format 3\0');
let cached: { configPath: string; at: number; missing: boolean } | undefined;

/** 清除短期诊断缓存；仅供测试，以及补取密钥后立即复核时使用。 */
export function resetDatabaseKeyDiagnosis(): void {
  cached = undefined;
}

async function readRegular(file: string, maximum: number, privateOnly: boolean): Promise<Buffer> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > maximum) throw new Error('database_key_diagnosis_invalid');
    if (privateOnly && ((stat.mode & 0o077) !== 0 || typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
      throw new Error('database_key_diagnosis_invalid');
    }
    const data = Buffer.alloc(stat.size);
    const { bytesRead } = await handle.read(data, 0, data.length, 0);
    if (bytesRead !== data.length) throw new Error('database_key_diagnosis_invalid');
    return data;
  } finally {
    await handle.close();
  }
}

async function readHeaderSalt(file: string): Promise<string | null> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 4096) return null;
    const header = Buffer.alloc(16);
    const { bytesRead } = await handle.read(header, 0, 16, 0);
    if (bytesRead !== 16 || header.equals(plainSqliteHeader)) return null;
    return header.toString('hex');
  } finally {
    await handle.close();
  }
}

async function check(configPath: string): Promise<boolean> {
  const text = (await readRegular(configPath, configByteLimit, true)).toString('utf8');
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const record = parsed as Record<string, unknown>;
  const root = record.db_root;
  const keys = record.keys;
  if (typeof root !== 'string' || !path.isAbsolute(root) || path.normalize(root) !== root || /[\0\r\n]/.test(root)) return false;
  if (!keys || typeof keys !== 'object' || Array.isArray(keys)) return false;
  // 只取密钥表里的盐（键名），不保留、不记录任何密钥值。
  const salts = new Set(Object.keys(keys).map(salt => salt.toLowerCase()));
  const salt = await readHeaderSalt(path.join(root, resourceDatabase));
  return salt !== null && !salts.has(salt);
}

/**
 * 图片资源库 message_resource.db 的当前文件头盐在已配置的密钥表中是否没有对应条目。
 * 只在能明确判断为“缺密钥”时返回 true；配置不可读、权限不符、库不存在或未加密时一律返回 false，
 * 不改变原有错误。结果短期缓存，避免逐条图片重复读取配置。
 */
export async function resourceDatabaseKeyMissing(configPath: string | undefined = process.env.NOTALONE_WECHAT_CONFIG, now = Date.now()): Promise<boolean> {
  if (!configPath || !path.isAbsolute(configPath) || /[\0\r\n]/.test(configPath)) return false;
  if (cached && cached.configPath === configPath && now - cached.at < 10_000) return cached.missing;
  let missing = false;
  try {
    missing = await check(configPath);
  } catch {
    missing = false;
  }
  cached = { configPath, at: now, missing };
  return missing;
}
