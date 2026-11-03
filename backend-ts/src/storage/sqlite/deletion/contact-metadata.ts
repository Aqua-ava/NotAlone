import { randomUUID } from 'node:crypto';
import { SqliteContactService } from '../../../contacts/sqlite/service.ts';
import { SqliteContactHttp } from '../../../contacts/sqlite/http.ts';
import { StorageFailure } from '../contracts.ts';
import type { ReadEligibility, ContactMetadataPort } from '../../../contacts/sqlite/contracts.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SqliteStorage } from '../client.ts';
import type { ActiveHolders } from './holders.ts';

type StopReaders=(contactId?:string)=>Promise<void>;
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
    const reader=await(this.foregroundReader??=this.snapshotStorage.openReader(['identity.foregroundSnapshot']));
    if(this.snapshotStopped)throw new StorageFailure('identity_closed');
    const snapshot=await reader.execute<import('../../../foreground/sqlite-foreground.ts').ForegroundSnapshot>('identity.foregroundSnapshot',{ownerId:this.ownerId});
    if(this.snapshotStopped)throw new StorageFailure('identity_closed');
    return snapshot;
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
/** 名单包含多位联系人；删除先关闭整个旧预览，再按持久资格重新创建空服务。 */
export class ContactMetadataLifetime {
  private readonly storage: SqliteStorage;
  readonly ownerId: string;
  private readonly holders: ActiveHolders;
  private readonly createMetadata: () => ContactMetadataPort;
  private service?: SqliteContactService;
  private http?: SqliteContactHttp;
  private released = true;
  private stopping = false;
  private reopening?: Promise<void>;
  private stopReaders:StopReaders=async()=>{};
  private startReaders:()=>void=()=>{};
  constructor(storage: SqliteStorage, ownerId: string, holders: ActiveHolders, createMetadata: () => ContactMetadataPort) {
    this.storage = storage; this.ownerId = ownerId; this.holders = holders; this.createMetadata = createMetadata;
  }
  async initialize(): Promise<void> {
    const service = this.create();
    await service.initialize();
    this.service = service; this.http = new SqliteContactHttp(service);
    if (await this.available()) this.bind(service); else await service.close();
  }
  private create(): SqliteContactService { return new ControlledContactService(this.storage, this.ownerId, this.createMetadata(),contactId=>this.stopReaders(contactId),()=>{if(!this.stopping&&!this.released)this.startReaders();}); }
  setReadStop(stopReaders:StopReaders):void {this.stopReaders=stopReaders;}
  setReadStart(startReaders:()=>void):void {this.startReaders=startReaders;}
  private available(): Promise<boolean> { return this.storage.execute('deletion.metadataAvailable', {ownerId: this.ownerId}); }
  private bind(service: SqliteContactService): void {
    this.holders.register({key: `identity:metadata_${randomUUID()}`, ownerId: this.ownerId, generation: 0n, coversAllContacts: true,
      close: async () => { if (this.service === service) this.released = true; await service.close(); }});
    this.service = service; this.http = new SqliteContactHttp(service); this.released = false;
  }
  private async refresh():Promise<void> {
    if (this.released && !this.stopping) {
      this.reopening ??= (async () => {
        if (await this.available() && !this.stopping) this.bind(this.create());
      })().finally(() => { this.reopening = undefined; });
      await this.reopening;
    }
  }
  private async current():Promise<SqliteContactService>{
    await this.refresh();
    if(this.stopping||this.released||!this.service)throw new StorageFailure('history_contact_gateway_unavailable');
    return this.service;
  }
  async eligibility(contactId:string){return (await this.current()).eligibility(contactId);}
  async validate(token:ReadEligibility){return (await this.current()).validate(token);}
  async directory(){return (await this.current()).directory();}
  async foregroundSnapshot(){return (await this.current()).foregroundSnapshot();}
  async confirmForeground(proof:import('../../../foreground/sqlite-foreground.ts').ForegroundBindingConfirmation){await (await this.current()).confirmForeground(proof);}
  async syncStatus(){await this.current();return this.http!.syncStatus();}
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    await this.refresh();
    return this.http!.handle(req,res);
  }
  async close(): Promise<void> {
    this.stopping = true;
    await this.reopening;
    await this.service?.close();
  }
}
