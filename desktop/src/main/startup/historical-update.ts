import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';

// 只检查旧流程留下的凭证；不恢复、复制或改写任何资料。
export async function historicalUpdateComplete(userData: string, managed: boolean): Promise<boolean> {
  try {
    let receipt: Record<string, unknown> | undefined;
    try {
      const file = await open(path.join(userData, 'update-operation.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const metadata = await file.stat();
        if (!metadata.isFile() || metadata.size > 8192 || metadata.mode & 0o077
          || process.getuid && metadata.uid !== process.getuid()) return false;
        const value: unknown = JSON.parse(await file.readFile('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        receipt = value as Record<string, unknown>;
      } finally { await file.close(); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false; }
    if (receipt && (Object.keys(receipt).length !== 6 || receipt.formatVersion !== 1 || receipt.completed !== true
      || typeof receipt.backup !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(receipt.backup)
      || typeof receipt.external !== 'boolean' || typeof receipt.fingerprint !== 'string'
      || !/^[a-f0-9]{64}$/.test(receipt.fingerprint) || typeof receipt.activeFingerprint !== 'string'
      || !/^[a-f0-9]{64}$/.test(receipt.activeFingerprint))) return false;
    if (managed) {
      const marker = await lstat(path.join(userData, 'managed/import-pending.json')).then(() => true,
        error => { if (error.code === 'ENOENT') return false; throw error; });
      if (marker && !receipt) return false;
    }
    return true;
  } catch { return false; }
}
