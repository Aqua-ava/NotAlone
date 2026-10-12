import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

type Identity = { dev: number; ino: number };
const same = (left: Identity, right: Identity) => left.dev === right.dev && left.ino === right.ino;
const metadata = async (directory: string) => {
  try { return await lstat(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
};

// 仅Finder验收夹具使用；不读取原目录文件，原目录整体移出后再创建空的测试目录。
export async function createFinderUserData(directory: string, ownedDirectory: string) {
  const backup = path.join(ownedDirectory, 'original-user-data');
  const original = await metadata(directory);
  if (original && (!original.isDirectory() || original.isSymbolicLink() || original.uid !== process.getuid?.())) {
    throw new Error('finder_user_data_unsafe');
  }
  if (await metadata(backup)) throw new Error('finder_backup_exists');
  await writeFile(path.join(ownedDirectory, 'restore-record.json'), JSON.stringify({
    directory, backup, originalIdentity: original ? { dev: original.dev, ino: original.ino } : null,
  }), { mode: 0o600 });
  if (original) await rename(directory, backup);
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) {
    // 不覆盖在空隙中出现的未知目录；原备份及恢复记录继续保留。
    if (original && !await metadata(directory)) await rename(backup, directory);
    throw error;
  }
  const ownedIdentity = (await lstat(directory));
  return {
    originalPresent: Boolean(original),
    originalIdentity: original ? { dev: original.dev, ino: original.ino } : null,
    ownedIdentity: { dev: ownedIdentity.dev, ino: ownedIdentity.ino },
    async restore() {
      const current = await metadata(directory);
      const saved = await metadata(backup);
      if (!current?.isDirectory() || current.isSymbolicLink() || !same(current, ownedIdentity)
        || (original && (!saved?.isDirectory() || saved.isSymbolicLink() || !same(saved, original)))) {
        throw new Error('finder_user_data_changed');
      }
      await rm(directory, { recursive: true });
      if (original) {
        await rename(backup, directory);
        if (!same(await lstat(directory), original)) throw new Error('finder_restore_unconfirmed');
      }
    },
  };
}
