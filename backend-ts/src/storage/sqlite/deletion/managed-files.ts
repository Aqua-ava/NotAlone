import { lstatSync, mkdirSync, realpathSync, unlinkSync, rmdirSync, openSync, closeSync, fsyncSync, constants } from 'node:fs';
import path from 'node:path';
import { StorageFailure } from '../contracts.ts';
import type { FileIdentity, ManagedAddress, ManagedArea } from './contracts.ts';

const names = { runtime: 'runtime-copies', media: 'media', cache: 'cache' } as const;
const same = (a: FileIdentity, b: FileIdentity) => a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs && a.uid === b.uid;
function inspect(location: string, directory: boolean, privateMode = true): FileIdentity {
  const s = lstatSync(location, {bigint: true});
  if (s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile()) || s.uid !== BigInt(process.getuid!())
    || (s.mode & (privateMode ? 0o077n : 0o022n)) !== 0n || (!directory && s.nlink !== 1n)) throw new StorageFailure('deletion_file_ownership');
  return { dev: String(s.dev), ino: String(s.ino), birthtimeNs: String(s.birthtimeNs), uid: String(s.uid) };
}
// 固定受管区；不接受外部根、绝对locator、SQLite目录、Skill或凭据目录。
export class ManagedFiles {
  private readonly root: string;
  private readonly rootIdentity: FileIdentity;
  private readonly managedIdentity: FileIdentity;
  constructor(userData: string) {
    if (!path.isAbsolute(userData) || realpathSync(userData) !== userData) throw new StorageFailure('deletion_file_ownership');
    this.root = userData; this.rootIdentity = inspect(userData, true, false);
    this.managedIdentity = inspect(path.join(userData, 'managed'), true);
  }
  private base(area: ManagedArea): string {
    if (!Object.hasOwn(names, area) || !same(inspect(this.root, true, false), this.rootIdentity)
      || !same(inspect(path.join(this.root, 'managed'), true), this.managedIdentity)) throw new StorageFailure('deletion_file_ownership');
    return path.join(this.root, 'managed', names[area]);
  }
  prepareArea(area: ManagedArea): void {
    const base = this.base(area);
    try { mkdirSync(base, {mode: 0o700}); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    inspect(base, true);
  }
  private parts(locator: string): string[] {
    const parts = locator.split('/');
    if (!parts.length || parts.length > 32 || parts.some(p => !/^[a-zA-Z0-9_.-]{1,128}$/.test(p) || p === '.' || p === '..')) throw new StorageFailure('deletion_file_ownership');
    return parts;
  }
  capture(area: ManagedArea, locator: string, kind: 'file' | 'directory' = 'file'): ManagedAddress {
    const parts = this.parts(locator), base = this.base(area);
    const ancestors = parts.map((_, i) => inspect(path.join(base, ...parts.slice(0, i)), true));
    return {area, locator, kind, ancestors, identity: inspect(path.join(base, ...parts), kind === 'directory')};
  }
  private location(address: ManagedAddress): { location: string; parent: string; absent: boolean } {
    const parts = this.parts(address.locator), base = this.base(address.area);
    if (address.ancestors.length !== parts.length) throw new StorageFailure('deletion_file_ownership');
    let absent = false;
    for (let i = 0; i < parts.length; i++) {
      try { if (!same(inspect(path.join(base, ...parts.slice(0, i)), true), address.ancestors[i])) throw new StorageFailure('deletion_file_identity_changed'); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; absent = true; break; }
    }
    return { location: path.join(base, ...parts), parent: path.join(base, ...parts.slice(0, -1)), absent };
  }
  erase(address: ManagedAddress): void {
    const {location, parent, absent} = this.location(address);
    if (absent) return;
    try {
      if (!same(inspect(location, address.kind === 'directory'), address.identity)) throw new StorageFailure('deletion_file_identity_changed');
      if (address.kind === 'directory') rmdirSync(location); else unlinkSync(location);
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    const fd = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  verifyAbsent(address: ManagedAddress): boolean {
    const {location, absent} = this.location(address);
    if (absent) return true;
    try { lstatSync(location); return false; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return true; throw e; }
  }
}
