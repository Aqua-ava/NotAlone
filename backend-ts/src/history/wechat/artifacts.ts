import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { StorageFailure } from '../../storage/sqlite/contracts.ts';
import type { NarrowWechatClientOptions } from './native-client.ts';

const manifestLimit = 64 * 1024;
const reject = (): never => { throw new StorageFailure('history_artifact_unverified'); };
async function regular(file: string) {
  if (!path.isAbsolute(file) || path.normalize(file) !== file || await realpath(file) !== file) return reject();
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) return reject();
  return stat;
}
/** 只读取显式制品旁的固定manifest；版本、补丁与实际制品hash仍由窄客户端复验。 */
export async function loadNarrowWechatOptions(executable: string): Promise<NarrowWechatClientOptions> {
  try {
    if (typeof executable !== 'string') return reject();
    await regular(executable);
    const file = path.join(path.dirname(path.dirname(executable)), 'manifest.json'), before = await regular(file);
    if (before.size > manifestLimit) return reject();
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > manifestLimit) return reject();
      const bytes = Buffer.alloc(manifestLimit + 1); let length = 0;
      while (length < bytes.length) {
        const result = await handle.read(bytes, length, bytes.length - length, length);
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      const after = await handle.stat(), current = await regular(file);
      if (length > manifestLimit || length !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
        || current.dev !== opened.dev || current.ino !== opened.ino) return reject();
      const manifest: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)));
      if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return reject();
      const row = manifest as Record<string, unknown>;
      if (typeof row.cliSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.cliSha256)
        || typeof row.wcdbSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.wcdbSha256)) return reject();
      return { executable, expectedCliSha256: row.cliSha256, expectedWcdbSha256: row.wcdbSha256 };
    } finally { await handle.close(); }
  } catch { return reject(); }
}
