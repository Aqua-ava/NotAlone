import { watch } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export async function cuaReceiptDirectory(project: string): Promise<string> {
  const requested = process.env.NOTALONE_LAYERED_CUA_DIR;
  if (!requested || !path.isAbsolute(requested)) throw new Error('实际验收须指定本轮私有收据目录。');
  const directory = await realpath(requested);
  const info = await stat(directory);
  if (!info.isDirectory() || (info.mode & 0o777) !== 0o700
      || directory === project || directory.startsWith(`${project}${path.sep}`)) {
    throw new Error('实际验收收据目录不可核验。');
  }
  return directory;
}

// 仅核验协调者完成实际操作后写入的本轮收据；不替代 Computer Use。
export async function waitForCuaReceipt(directory: string, requestId: string, requiredChecks: string[], timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let checking = false;
    let settled = false;
    const watcher = watch(directory, (_event, filename) => { if (filename === 'done.json') void check(); });
    const timer = setTimeout(() => finish(new Error('本次CUA未在有限期限内完成。')), timeoutMs);
    function finish(error?: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      watcher.close();
      if (error) reject(error); else resolve();
    }
    async function check() {
      if (checking || settled) return;
      checking = true;
      try {
        const receipt = JSON.parse(await readFile(path.join(directory, 'done.json'), 'utf8'));
        if (receipt.request_id !== requestId || receipt.passed !== true) throw new Error('CUA收据未通过或不属于本次实例。');
        if (!requiredChecks.every((name) => receipt.checks?.[name] === true)) {
          throw new Error('CUA收据未包含本次全部实际操作。');
        }
        finish();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') finish(error as Error);
      } finally { checking = false; }
    }
    void check();
  });
}
