import { StorageFailure } from '../contracts.ts';
import type { DeletionOperation } from './contracts.ts';

export interface ActiveResource { key: string; ownerId: string; contactId?: string; coversAllContacts?: boolean; generation: bigint; close: () => Promise<void> }
interface HeldResource extends ActiveResource { closing?: Promise<void> }
const scopedKey = (owner: string, key: string) => JSON.stringify([owner, key]);
// 先登记后使用；close回调必须等待官方dispose/close、finally和末次写入，不得仅发cancel。
export class ActiveHolders {
  private readonly held = new Map<string, HeldResource>();
  private readonly blockedKeys = new Set<string>();
  private readonly blockedOwners = new Map<string, bigint>();
  private readonly blockedContacts = new Map<string, bigint>();
  register(resource: Omit<HeldResource, 'closing'>): () => Promise<void> {
    const key = scopedKey(resource.ownerId, resource.key);
    const fence = [this.blockedContacts.get(JSON.stringify([resource.ownerId, resource.contactId])), this.blockedOwners.get(resource.ownerId)]
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
  }
  private matching(op: DeletionOperation, keys: string[]): HeldResource[] {
    return [...this.held.values()].filter(r => r.ownerId === op.ownerId && (keys.includes(r.key) || op.scope.kind === 'account'
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
