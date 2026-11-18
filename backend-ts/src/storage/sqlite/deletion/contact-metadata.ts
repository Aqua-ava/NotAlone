import {ContactAvatarSynchronizer} from '../../../contacts/sqlite/avatar-sync.ts';
import { randomUUID } from 'node:crypto';
import { SqliteContactService } from '../../../contacts/sqlite/service.ts';
import { SqliteContactHttp } from '../../../contacts/sqlite/http.ts';
import { StorageFailure } from '../contracts.ts';
import { sendJson } from '../../../platform/http/json.ts';
import type { ReadEligibility, ContactMetadataPort } from '../../../contacts/sqlite/contracts.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SqliteStorage } from '../client.ts';
import type { ActiveHolders } from './holders.ts';

type StopReaders=(contactId?:string)=>Promise<void>;
// 名单读侧准入：联系人删除在 plan 事务封禁后仍可重建名单服务供其他联系人与授权状态读取；
// writable 仍按严格语义，early-open 期间拒绝身份写入与敏感名单预览。
interface MetadataAdmission { available: boolean; writable: boolean; admittedOperations: string[] }
const closedAdmission: MetadataAdmission = { available: false, writable: false, admittedOperations: [] };
const readerResetCodes = new Set(['schema_drift', 'stale_lease', 'readonly_closed']);
const resetReaderCode = (error: unknown): boolean => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && readerResetCodes.has(code);
};
class ControlledContactService extends SqliteContactService {
  private readonly stopReaders:StopReaders;
  private readonly startReaders:()=>void;
  private readonly snapshotStorage:SqliteStorage;
  private foregroundReader?:ReturnType<SqliteStorage['openReader']>;
  private snapshotStopped=false;
  private snapshotClosing?:Promise<void>;
  constructor(storage:SqliteStorage,ownerId:string,metadata:ContactMetadataPort,stopReaders:StopReaders,startReaders:()=>void){super(storage,ownerId,metadata);this.snapshotStorage=storage;this.stopReaders=stopReaders;this.startReaders=startReaders;}
  override async foregroundSnapshot():Promise<import('../../../foreground/sqlite-foreground.ts').ForegroundSnapshot>{
    if(this.snapshotStopped)throw new StorageFailure('identity_closed');
    for(let attempt=0;;attempt++){
      const reader=await(this.foregroundReader??=this.snapshotStorage.openReader(['identity.foregroundSnapshot']));
      if(this.snapshotStopped)throw new StorageFailure('identity_closed');
      try{
        return await reader.execute<import('../../../foreground/sqlite-foreground.ts').ForegroundSnapshot>('identity.foregroundSnapshot',{ownerId:this.ownerId});
      }catch(error){
        // 删除后的 VACUUM 会推进 schema 版本，早开的名单服务可能跨过压缩；旧 reader 失效时重建一次。
        if(attempt>0||this.snapshotStopped||!resetReaderCode(error))throw error;
        const stale=this.foregroundReader;this.foregroundReader=undefined;
        void stale.then(reader=>reader.close().catch(()=>{}),()=>{});
      }
    }
  }
  override async confirm(...args:Parameters<SqliteContactService['confirm']>){const result=await super.confirm(...args);this.startReaders();return result;}
  override async setReading(enabled:boolean){const result=await super.setReading(enabled);if(enabled)this.startReaders();else await this.stopReaders();return result;}
  override async revoke(contactId:string,bindingId:string,generation:string){const result=await super.revoke(contactId,bindingId,generation);await this.stopReaders(contactId);return result;}
  override close():Promise<void>{
    this.snapshotStopped=true;
    return this.snapshotClosing??=(async()=>{
      // 名单删除和退出必须一并排空附属读者，不能只关闭原来的渠道预览。
      const results=await Promise.allSettled([super.close(),this.foregroundReader?.then(reader=>reader.close(),()=>{})]);
      const failures=results.filter((result):result is PromiseRejectedResult=>result.status==='rejected');
      if(failures.length)throw new AggregateError(failures.map(result=>result.reason),'FOREGROUND_READER_CLOSE_FAILED');
    })().catch(error=>{this.snapshotClosing=undefined;throw error;});
  }
}
/** 名单包含多位联系人；联系人删除在封禁后允许只读重建，账户删除与身份写入继续关闭名单服务。 */
export class ContactMetadataLifetime {
  private readonly storage: SqliteStorage;
  readonly ownerId: string;
  private readonly holders: ActiveHolders;
  private readonly createMetadata: () => ContactMetadataPort;
  private readonly avatars:ContactAvatarSynchronizer;
  private service?: SqliteContactService;
  private http?: SqliteContactHttp;
  private admission: MetadataAdmission = closedAdmission;
  private stopping = false;
  private reopening?: Promise<void>;
  private stopReaders:StopReaders=async()=>{};
  private startReaders:()=>void=()=>{};
  constructor(storage: SqliteStorage, ownerId: string, holders: ActiveHolders, createMetadata: () => ContactMetadataPort) {
    this.storage = storage; this.ownerId = ownerId; this.holders = holders; this.createMetadata = createMetadata;
    this.avatars=new ContactAvatarSynchronizer(this);
  }
  async initialize(): Promise<void> {
    const service = this.create();
    await service.initialize();
    // identity.initialize 会建立/确认 owner，准入必须在它之后读取。
    this.admission = await this.admit();
    if (this.admission.available) this.bind(service);
    else {
      // 关闭期间沿用原路由投影（目录/绑定 409 identity_closed，检测返回工具未就绪），不以 503 代替。
      this.http = new SqliteContactHttp(service);
      await service.close();
    }
  }
  private create(): SqliteContactService { return new ControlledContactService(this.storage, this.ownerId, this.createMetadata(),contactId=>this.stopReaders(contactId),()=>{if(!this.stopping&&this.service)this.startReaders();}); }
  setReadStop(stopReaders:StopReaders):void {this.stopReaders=stopReaders;}
  setReadStart(startReaders:()=>void):void {this.startReaders=()=>{this.wakeAvatarSync();startReaders();};}
  wakeAvatarSync():void {if(!this.stopping&&this.service)this.avatars.wake();}
  async stopAvatarSync(contactId?:string){await this.avatars.stop(contactId);}
  async syncAvatar(contactId:string,signal?:AbortSignal){return (await this.current()).syncAvatar(contactId,signal);}
  private admit(): Promise<MetadataAdmission> {
    return this.storage.execute<MetadataAdmission>('deletion.metadataAdmission', {ownerId: this.ownerId});
  }
  private bind(service: SqliteContactService): void {
    // admittedOperations 只由可信 lifetime 传入：这些联系人删除已封禁身份，早开的名单读者不进入其闭包。
    this.holders.register({key: `identity:metadata_${randomUUID()}`, ownerId: this.ownerId, generation: 0n,
      coversAllContacts: true, admittedDeletionIds: [...this.admission.admittedOperations], close: () => this.release(service)});
    this.service = service; this.http = new SqliteContactHttp(service);
  }
  private async release(service: SqliteContactService): Promise<void> {
    // 先完成实际关闭再标记可重建；close 失败时保留引用，让 holder drain 在原操作重试。
    await service.close();
    if (this.service !== service) return;
    // http 保留指向已关闭服务，让名单关闭期间的读路由沿用既有 identity_closed 投影；重建时会被替换。
    this.service = undefined;
  }
  private async refresh(known?: MetadataAdmission):Promise<void> {
    // 名单已打开时不在每次读取前访问主 Worker：前台快照等专用读者不能等后台 SQL。
    if (this.stopping || this.service) return;
    this.reopening ??= (async () => {
      const admission = known ?? await this.admit();
      if (this.stopping) return;
      this.admission = admission;
      if (admission.available) this.bind(this.create());
    })().finally(() => { this.reopening = undefined; });
    await this.reopening;
  }
  // 写入门禁与敏感名单预览需要最新准入；只有这些请求在主 Worker 上额外复查。
  private async refreshAdmission():Promise<void> {
    const admission = await this.admit();
    this.admission = admission;
    if (!admission.available) {
      const existing = this.service;
      if (existing) await this.release(existing);
      return;
    }
    if (!this.service) await this.refresh(admission);
  }
  private async current():Promise<SqliteContactService>{
    await this.refresh();
    if(this.stopping||!this.service)throw new StorageFailure('history_contact_gateway_unavailable');
    return this.service;
  }
  async eligibility(contactId:string){return (await this.current()).eligibility(contactId);}
  async validate(token:ReadEligibility){return (await this.current()).validate(token);}
  async directory(){return (await this.current()).directory();}
  async syncDirectory(){return (await this.current()).syncDirectory();}
  async foregroundSnapshot(){return (await this.current()).foregroundSnapshot();}
  async syncSnapshot(){return (await this.current()).syncSnapshot();}
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    if (this.stopping) return this.deny(res);
    const sensitive = req.method !== 'GET' || this.path(req) === '/api/sync/cli-sessions';
    if (sensitive) await this.refreshAdmission();
    else await this.refresh();
    const http = this.http;
    if (!this.admission.available) return http ? http.handle(req,res) : this.deny(res);
    // 早开窗口只放开读取；身份写入与可能把已删联系人重新列为候选的名单预览仍等 completed。
    if (sensitive && !this.admission.writable) return this.deny(res);
    return http ? http.handle(req,res) : this.deny(res);
  }
  private path(req: IncomingMessage): string | undefined {
    try { return new URL(req.url ?? '', 'http://localhost').pathname; } catch { return undefined; }
  }
  private deny(res: ServerResponse): boolean {
    sendJson(res, 409, {error: 'identity_closed'});
    return true;
  }
  async close(): Promise<void> {
    this.stopping = true;
    await this.avatars.close();
    await this.reopening;
    const service = this.service;
    if (service) await this.release(service);
  }
}
