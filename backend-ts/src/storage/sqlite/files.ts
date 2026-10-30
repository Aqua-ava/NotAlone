import { constants, lstatSync, mkdirSync, openSync, closeSync, realpathSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { StorageFailure } from './contracts.ts';

type Identity = { dev: number; ino: number };
function inspect(location: string, directory: boolean, privateMode: boolean): Identity {
  const s = lstatSync(location);
  if (s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile())
    || s.uid !== process.getuid?.() || (directory ? false : s.nlink !== 1)
    || (privateMode ? (s.mode & 0o777) !== (directory ? 0o700 : 0o600) : (s.mode & 0o022) !== 0)) {
    throw new StorageFailure('unsafe_storage_path');
  }
  return { dev: s.dev, ino: s.ino };
}
export function controlledFiles(userData: string, create: boolean) {
  if (!path.isAbsolute(userData) || realpathSync(userData) !== userData) throw new StorageFailure('unsafe_storage_path');
  const rootIdentity = inspect(userData, true, false);
  const managed = path.join(userData, 'managed');
  const directory = path.join(managed, 'sqlite');
  for (const p of [managed, directory]) {
    if (create) { try { mkdirSync(p, {mode: 0o700}); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; } }
    inspect(p, true, true);
  }
  const directories = [managed, directory].map(p => inspect(p, true, true));
  const database = path.join(directory, 'notalone.sqlite');
  if (create) {
    if (readdirSync(directory).length) throw new StorageFailure('storage_already_exists');
    // 排他创建，不截断任何已有数据库。未完成初始化的文件保留供诊断。
    const fd = openSync(database, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    closeSync(fd);
  }
  const identity = inspect(database, false, true);
  const verify = () => {
    const same = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino;
    if (!same(inspect(userData, true, false), rootIdentity)
      || !same(inspect(database, false, true), identity)
      || [managed, directory].some((p, i) => !same(inspect(p, true, true), directories[i]))) throw new StorageFailure('storage_identity_changed');
    for (const suffix of ['-wal', '-shm', '-journal']) {
      try { inspect(database + suffix, false, true); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    }
  };
  verify();
  const inspectSidecars = () => {
    verify();
    const size = (suffix: string): bigint => {
      try { return statSync(database + suffix, {bigint: true}).size; }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0n; throw e; }
    };
    return {walBytes: size('-wal'), shmBytes: size('-shm'), journalBytes: size('-journal'),
      unexpectedFiles: readdirSync(directory).filter(name => !['notalone.sqlite', 'notalone.sqlite-wal', 'notalone.sqlite-shm', 'notalone.sqlite-journal'].includes(name)).length};
  };
  return { database, verify, inspectSidecars };
}
