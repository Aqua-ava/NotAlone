import type { FileIdentity, ManagedAddress } from './contracts.ts';

// 受管文件身份只比较 inode、创建时间与属主，不含系统设备号：设备号会随重启或重新挂载变化，
// 不能代表文件是否被替换。旧记录中可能带有 dev，读取、比较与校验一律忽略。
export const sameFileIdentity = (a: FileIdentity, b: FileIdentity): boolean => a.ino === b.ino && a.birthtimeNs === b.birthtimeNs && a.uid === b.uid;
const bare = (id: FileIdentity): FileIdentity => ({ ino: id.ino, birthtimeNs: id.birthtimeNs, uid: id.uid });
/** 去掉旧记录中的设备号并固定键序，供已保存地址与当前捕获结果比较。 */
export function withoutDevice(address: ManagedAddress): ManagedAddress {
  return { area: address.area, locator: address.locator, kind: address.kind, ancestors: address.ancestors.map(bare), identity: bare(address.identity) };
}
export const sameManagedAddress = (a: ManagedAddress, b: ManagedAddress): boolean => JSON.stringify(withoutDevice(a)) === JSON.stringify(withoutDevice(b));
/** 必填字段为十进制整数字符串；设备号不再要求，旧记录若带有则不校验。 */
export const validFileIdentity = (id: unknown): boolean => !!id && typeof id === 'object'
  && ['ino', 'birthtimeNs', 'uid'].every(k => { const v = (id as Record<string, unknown>)[k]; return typeof v === 'string' && /^\d+$/.test(v); });
