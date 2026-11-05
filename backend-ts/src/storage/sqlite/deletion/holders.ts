import { StorageFailure } from '../contracts.ts';
import type { DeletionOperation } from './contracts.ts';

// coversAllSources只用于声明可能持有该联系人任意来源的读者，其他领域默认不扩大匹配。
// scopeKeys把临时读者纳入既有删除闭包；每次持有者仍使用独立的唯一key。
// admittedDeletionIds只由可信的名单 lifetime 登记：这些联系人删除已封禁对应身份，名单读者只读活跃联系人，
// 因此不进入该操作后续的 drain/verify 闭包；未登记准入的旧读者仍按原规则关闭。
export interface ActiveResource { key: string; scopeKeys?: readonly string[]; ownerId: string; contactId?: string; coversAllContacts?: boolean; coversAllSources?: boolean; admittedDeletionIds?: readonly string[]; generation: bigint; close: () => Promise<void> }
interface HeldResource extends ActiveResource { closing?: Promise<void> }
const scopedKey = (owner: string, key: string) => JSON.stringify([owner, key]);
// 先登记后使用；close回调必须等待官方dispose/close、finally和末次写入，不得仅发cancel。
export class ActiveHolders {
  private readonly held = new Map<string, HeldResource>();
  private readonly blockedKeys = new Set<string>();
  private readonly blockedOwners = new Map<string, bigint>();
  private readonly blockedContacts = new Map<string, bigint>();
  private readonly blockedSourceContacts = new Map<string, bigint>();
  register(resource: Omit<HeldResource, 'closing'>): () => Promise<void> {
    const key = scopedKey(resource.ownerId, resource.key);
    const contactKey = JSON.stringify([resource.ownerId, resource.contactId]);
    const fence = [this.blockedContacts.get(contactKey), this.blockedOwners.get(resource.ownerId),
      resource.coversAllSources === true ? this.blockedSourceContacts.get(contactKey) : undefined]
      .reduce<bigint>((max, value) => value !== undefined && value > max ? value : max, -1n);
    if (typeof resource.generation !== 'bigint' || resource.generation < 0n || this.held.has(key) || this.blockedKeys.has(key)
      || resource.generation < fence) throw new StorageFailure('deletion_holder_fenced');
    this.held.set(key, resource);
    return () => this.close(resource);
  }
  private close(resource: HeldResource): Promise<void> {
    return resource.closing ??= Promise.resolve().then(resource.close).then(() => { this.held.delete(scopedKey(resource.ownerId, resource.key)); }, error => {
      // 只有明确失败才允许重新调用；超时不能释放仍在进行的close。
      resource.closing = undefined; throw error;
    });
  }
  fence(op: DeletionOperation, keys: string[]): void {
    for (const key of [...keys, ...this.matching(op, keys).map(r => r.key)]) this.blockedKeys.add(scopedKey(op.ownerId, key));
    const advance = (map: Map<string, bigint>, key: string) => map.set(key, op.acceptedGeneration > (map.get(key) ?? -1n) ? op.acceptedGeneration : map.get(key)!);
    if (op.scope.kind === 'account') advance(this.blockedOwners, op.ownerId);
    if (op.scope.kind === 'contact' || op.scope.kind === 'contact_history') advance(this.blockedContacts, JSON.stringify([op.ownerId, op.scope.contactId]));
    if (op.scope.kind === 'source') advance(this.blockedSourceContacts, JSON.stringify([op.ownerId, op.scope.contactId]));
  }
  private admitted(r: HeldResource, op: DeletionOperation): boolean {
    return op.scope.kind === 'contact' && r.coversAllContacts === true && r.admittedDeletionIds?.includes(op.operationId) === true;
  }
  private matching(op: DeletionOperation, keys: string[]): HeldResource[] {
    return [...this.held.values()].filter(r => r.ownerId === op.ownerId && !this.admitted(r, op) && (keys.includes(r.key) || r.scopeKeys?.some(key=>keys.includes(key)) || op.scope.kind === 'account'
      || (op.scope.kind === 'source' && r.coversAllSources === true && r.contactId === op.scope.contactId && r.generation < op.acceptedGeneration)
      || ((op.scope.kind === 'contact' || op.scope.kind === 'contact_history') && (r.coversAllContacts || (r.contactId === op.scope.contactId && r.generation < op.acceptedGeneration)))));
  }
  async drain(op: DeletionOperation, keys: string[], timeoutMs: number): Promise<void> {
    this.fence(op, keys);
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([Promise.all(this.matching(op, keys).map(r => this.close(r))), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new StorageFailure('deletion_holder_timeout')), timeoutMs);
      })]);
      if (this.matching(op, keys).length) throw new StorageFailure('deletion_live_refs');
    } catch (error) { throw error instanceof StorageFailure ? error : new StorageFailure('deletion_holder_close_failed'); }
    finally { clearTimeout(timer); }
  }
  verify(op: DeletionOperation, keys: string[]): boolean { return this.matching(op, keys).length === 0; }
}
