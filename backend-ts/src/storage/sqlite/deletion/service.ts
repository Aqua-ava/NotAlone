import { StorageFailure,type StorageReader } from '../contracts.ts';
import type { SqliteStorage } from '../client.ts';
import type { CheckResult, DeletionScope, DeletionSnapshot } from './contracts.ts';
import type { ActiveHolders } from './holders.ts';
import type { ManagedFiles } from './managed-files.ts';

type Address = { ownerId: string; operationId: string };
type Claimed = DeletionSnapshot & { token: string | null };
type Runner = Address & { token: string; planRevision: bigint };
const passed = (proof: string): CheckResult => ({result: 'passed', proof});
// 外部排空及文件I/O位于事务外，所有进度回写都复验runner、实例和计划修订。
export class DeletionService {
  private readonly storage: SqliteStorage;
  private readonly holders: ActiveHolders;
  private readonly files: ManagedFiles;
  private readonly options: {drainTimeoutMs: number};
  private readonly reader:Pick<StorageReader,'execute'>;
  constructor(storage: SqliteStorage, holders: ActiveHolders, files: ManagedFiles, options:{drainTimeoutMs?:number;reader?:Pick<StorageReader,'execute'>} = {}) {
    this.storage = storage; this.holders = holders; this.files = files; this.options = {drainTimeoutMs:options.drainTimeoutMs??5_000};this.reader=options.reader??storage;
  }
  async plan(input: { ownerId: string; requestKey: string; scope: DeletionScope }): Promise<DeletionSnapshot> {
    const op = await this.storage.execute<DeletionSnapshot>('deletion.plan', input);
    this.holders.fence(op, op.targets.flatMap(t => t.target?.holderKeys ?? []));
    return op;
  }
  status(input: Address): Promise<DeletionSnapshot> { return this.reader.execute('deletion.status', input); }
  list(input: {ownerId: string; contactId?: string}): Promise<DeletionSnapshot[]> { return this.reader.execute('deletion.list', input); }
  async advance(input: Address): Promise<DeletionSnapshot> {
    const cleaned = await this.clean(input);
    if ('final' in cleaned) return cleaned.final;
    return this.compactAndVerify([cleaned.runner]).then(([op]) => op!);
  }
  /**
   * 批量推进多个操作：逐个完成清理并封存，随后只做一次全库压缩，再逐个核验结案。
   * 每个操作仍只在“其最后一次清除之后开始的压缩”通过后才结案，规格的“结案前必须完成压缩”不变；
   * 压缩（VACUUM 加全库校验）随库体积增长，与联系人大小无关，合并后 N 个操作只付一次。
   * 中途崩溃时已封存未核验的操作停在清理态，沿原任务再次 advance 即可补齐（与单个推进的失败现场一致）。
   */
  async advanceBatch(inputs: Address[]): Promise<DeletionSnapshot[]> {
    const results = new Map<string, DeletionSnapshot>();
    const pending: Runner[] = [];
    for (const input of inputs) {
      const cleaned = await this.clean(input);
      if ('final' in cleaned) results.set(input.operationId, cleaned.final); else pending.push(cleaned.runner);
    }
    if (pending.length) for (const op of await this.compactAndVerify(pending)) results.set(op.operationId, op);
    // 核验时闭包出现新目标的操作（fenced）沿原任务单独推进，与单个删除入口一致。
    for (const input of inputs) {
      for (let i = 0; i < 3 && results.get(input.operationId)?.state === 'fenced'; i++) results.set(input.operationId, await this.advance(input));
    }
    return inputs.map(input => results.get(input.operationId)!);
  }
  private async clean(input: Address): Promise<{ final: DeletionSnapshot } | { runner: Runner }> {
    let op = await this.storage.execute<Claimed>('deletion.claim', input);
    if (!op.token) return { final: op };
    let runner: Runner = {...input, token: op.token, planRevision: op.planRevision};
    let keys = op.targets.flatMap(t => t.target?.holderKeys ?? []);
    let targetNo: bigint | undefined;
    try {
      // close可产生末次文件/持有者；每次排空后重新收集，达到稳定闭包才开始清理。
      let stable = false;
      for (let round = 0; round < 8; round++) {
        await this.holders.drain(op, keys, this.options.drainTimeoutMs);
        const revision = op.planRevision;
        op = await this.storage.execute<Claimed>('deletion.recollect', runner);
        runner = {...runner, planRevision: op.planRevision};
        keys = [...new Set([...keys, ...op.targets.flatMap(t => t.target?.holderKeys ?? [])])];
        if (revision === op.planRevision && this.holders.verify(op, keys)) { stable = true; break; }
      }
      if (!stable) throw new StorageFailure('deletion_closure_unstable');
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
      return { runner };
    } catch (error) {
      return { final: await this.blocked(runner, targetNo, error) };
    }
  }
  /** 一次压缩覆盖全部已封存的操作；压缩失败时每个操作都停在受阻态，可沿原任务重试。 */
  private async compactAndVerify(runners: Runner[]): Promise<DeletionSnapshot[]> {
    let maintenance: CheckResult | undefined, failure: unknown;
    try { maintenance = await this.storage.execute<CheckResult>('deletion.compact', {}); }
    catch (error) { failure = error; }
    const done: DeletionSnapshot[] = [];
    for (const runner of runners) {
      try {
        if (!maintenance) throw failure;
        done.push(await this.storage.execute<DeletionSnapshot>('deletion.verify', {...runner, checks: { sqlite_pages_wal: maintenance }}));
      } catch (error) { done.push(await this.blocked(runner, undefined, error)); }
    }
    return done;
  }
  private blocked(runner: Runner, targetNo: bigint | undefined, error: unknown): Promise<DeletionSnapshot> {
    return this.storage.execute('deletion.blocked', {...runner, targetNo, code: error instanceof StorageFailure ? error.code : 'cleanup_failed'});
  }
}
