import { StorageFailure } from '../contracts.ts';
import type { SqliteStorage } from '../client.ts';
import type { CheckResult, DeletionScope, DeletionSnapshot } from './contracts.ts';
import type { ActiveHolders } from './holders.ts';
import type { ManagedFiles } from './managed-files.ts';

type Address = { ownerId: string; operationId: string };
type Claimed = DeletionSnapshot & { token: string | null };
const passed = (proof: string): CheckResult => ({result: 'passed', proof});
// 外部排空及文件I/O位于事务外，所有进度回写都复验runner、实例和计划修订。
export class DeletionService {
  private readonly storage: SqliteStorage;
  private readonly holders: ActiveHolders;
  private readonly files: ManagedFiles;
  private readonly options: {drainTimeoutMs: number};
  constructor(storage: SqliteStorage, holders: ActiveHolders, files: ManagedFiles, options = {drainTimeoutMs: 5_000}) {
    this.storage = storage; this.holders = holders; this.files = files; this.options = options;
  }
  async plan(input: { ownerId: string; requestKey: string; scope: DeletionScope }): Promise<DeletionSnapshot> {
    const op = await this.storage.execute<DeletionSnapshot>('deletion.plan', input);
    this.holders.fence(op, op.targets.flatMap(t => t.target?.holderKeys ?? []));
    return op;
  }
  status(input: Address): Promise<DeletionSnapshot> { return this.storage.execute('deletion.status', input); }
  list(input: {ownerId: string; contactId?: string}): Promise<DeletionSnapshot[]> { return this.storage.execute('deletion.list', input); }
  async advance(input: Address): Promise<DeletionSnapshot> {
    const op = await this.storage.execute<Claimed>('deletion.claim', input);
    if (!op.token) return op;
    const runner = {...input, token: op.token, planRevision: op.planRevision};
    const keys = op.targets.flatMap(t => t.target?.holderKeys ?? []);
    let targetNo: bigint | undefined;
    try {
      await this.holders.drain(op, keys, this.options.drainTimeoutMs);
      const targets = [...op.targets].sort((a, b) => {
        const rank = (item: typeof a) => item.target?.kind === 'file' && item.target.address.kind === 'directory' ? 1000 - item.target.address.locator.split('/').length : 0;
        return rank(a) - rank(b);
      });
      for (const item of targets) {
        if (item.state === 'cleared' || !item.target) continue;
        targetNo = item.targetNo;
        if (item.target.kind === 'file') {
          await this.storage.execute('deletion.authorizeFile', {...runner, targetNo});
          this.files.erase(item.target.address);
        }
        await this.storage.execute('deletion.clearTarget', {...runner, targetNo});
      }
      targetNo = undefined;
      const filesOkay = op.targets.every(t => t.target?.kind !== 'file' || this.files.verifyAbsent(t.target.address));
      await this.storage.execute('deletion.sealTargets', {...runner, checks: {
        runtime_files: filesOkay ? passed('managed_targets_absent') : {result: 'blocked', proof: 'managed_targets_remain'},
        runtime_live_refs: this.holders.verify(op, keys) ? passed('holders_released') : {result: 'blocked', proof: 'holders_remain'},
      }});
      const maintenance = await this.storage.execute<CheckResult>('deletion.compact', {});
      return await this.storage.execute('deletion.verify', {...runner, checks: {
        sqlite_pages_wal: maintenance,
      }});
    } catch (error) {
      return this.storage.execute('deletion.blocked', {...runner, targetNo, code: error instanceof StorageFailure ? error.code : 'cleanup_failed'});
    }
  }
}
