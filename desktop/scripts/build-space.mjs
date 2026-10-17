import fs from 'node:fs/promises';
import path from 'node:path';

const minimumBytes = 15n * 1024n ** 3n;

export async function requireBuildSpace(directories, inspectSpace = fs.statfs) {
  for (const target of new Set(directories)) {
    let directory = path.resolve(target);
    let available;
    try {
      let space;
      for (;;) {
        try {
          space = await inspectSpace(directory, { bigint: true });
          break;
        } catch (cause) {
          if (cause.code !== 'ENOENT' || path.dirname(directory) === directory) throw cause;
          // 未创建的输出检查最近祖先；失效软链接无法确定目标卷时停止。
          const entry = await fs.lstat(directory).catch((error) => {
            if (error.code !== 'ENOENT') throw error;
          });
          if (entry?.isSymbolicLink()) throw cause;
          directory = path.dirname(directory);
        }
      }
      available = space.bavail * space.bsize;
      if (typeof available !== 'bigint' || available < 0n) throw new Error('invalid_space');
    } catch (cause) {
      throw Object.assign(new Error('无法核验构建可用空间，已停止创建产物。', { cause }), {
        code: 'build_disk_space_unavailable',
      });
    }
    if (available < minimumBytes) {
      throw Object.assign(new Error(`构建至少需要 15 GiB 可用空间，当前约 ${(Number(available) / 1024 ** 3).toFixed(1)} GiB。请先清理已确认闲置的开发产物。`), {
        code: 'build_disk_space_low',
      });
    }
  }
}
