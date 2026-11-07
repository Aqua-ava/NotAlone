import {randomUUID} from 'node:crypto';
import {StorageFailure} from '../../storage/sqlite/contracts.ts';
import type {SqliteStorage} from '../../storage/sqlite/client.ts';
import type {DeletionService} from '../../storage/sqlite/deletion/service.ts';
import type {SupersededPending,SupersededPreview} from './superseded-actions.ts';

export interface SupersededCleanupResult {contactId:string;batches:number;blocked:boolean;reason:string|null}
export interface SupersededCleanupOptions {
 /** 单次运行最多处理的批次数（每批最多 `supersededBatchMessages` 条消息）。 */
 maxBatches?:number;
 /** 每批完成后通知，例如刷新界面；失败不影响清理。 */
 changed?:(contactId:string)=>void|Promise<void>;
 /** 清理因暂时原因（例如压缩时有长读者）停在未结案时，自动重试的间隔与次数；0 关闭。 */
 retryDelayMs?:number;
 maxRetries?:number;
}

/**
 * 修复同步通过后清理被取代绑定副本的驱动（ADR-175）。
 *
 * 只负责“何时、以什么顺序”调用统一删除服务：每批先只读预览，再计划一个有界的
 * `superseded_history` 操作并推进到结案；已计划但未结案的操作按原操作续跑。
 * 所有资格、引用判定与清除都在删除框架的短事务内完成；这里不触碰读取资格，也不写排除项。
 * 全局串行，避免多位联系人同时压缩数据库。
 */
export class SupersededHistoryCleanup {
 private readonly storage:Pick<SqliteStorage,'execute'>;
 private readonly ownerId:string;
 private readonly deletion:Pick<DeletionService,'plan'|'advance'>;
 private readonly options:SupersededCleanupOptions;
 private tail:Promise<unknown>=Promise.resolve();
 private closed=false;
 constructor(storage:Pick<SqliteStorage,'execute'>,ownerId:string,deletion:Pick<DeletionService,'plan'|'advance'>,options:SupersededCleanupOptions={}) {
  this.storage=storage;this.ownerId=ownerId;this.deletion=deletion;this.options=options;
 }
 /** 修复完成后调用：排队后台清理，失败只保留账本现场，等待下次触发或重启续跑。 */
 schedule(contactId:string,attempt=0):void {
  if(this.closed)return;
  void this.run(contactId).then(result=>{
   // 未结案多为压缩遇到长读者等暂时原因：隔一段时间沿原操作重试几次，仍不行就留给下次触发或重启续跑。
   const delay=this.options.retryDelayMs??60_000;
   if(result.blocked&&delay>0&&attempt<(this.options.maxRetries??3)&&!this.closed){
    const timer=setTimeout(()=>this.schedule(contactId,attempt+1),delay*(attempt+1));timer.unref();
   }
  },()=>{});
 }
 /** 等待并返回结果；同一时刻只有一个清理在推进。 */
 run(contactId:string):Promise<SupersededCleanupResult> {
  const task=this.tail.then(()=>this.closed?{contactId,batches:0,blocked:false,reason:'closed'}:this.runLocked(contactId),()=>this.runLocked(contactId));
  this.tail=task.catch(()=>{});
  return task;
 }
 /** 启动后续跑：登记过请求的联系人与尚未结案的清理操作；不会主动清理没有登记的存量副本。 */
 async resume():Promise<SupersededCleanupResult[]> {
  const pending=await this.storage.execute<SupersededPending>('history.supersededPending',{ownerId:this.ownerId});
  const contacts=[...new Set([...pending.contacts,...pending.operations.map(op=>op.contactId)])];
  const results:SupersededCleanupResult[]=[];
  for(const contactId of contacts){if(this.closed)break;results.push(await this.run(contactId));}
  return results;
 }
 async close():Promise<void> {this.closed=true;await this.tail.catch(()=>{});}

 private async advance(operationId:string):Promise<string> {
  let state='';
  for(let attempt=0;attempt<4;attempt++){
   try{state=(await this.deletion.advance({ownerId:this.ownerId,operationId})).state;}
   catch(error){return error instanceof StorageFailure?error.code:'cleanup_failed';}
   // 核验时闭包出现新目标（fenced）的操作沿原任务再推进；其余状态已是终态。
   if(state!=='fenced')break;
  }
  return state;
 }
 private async runLocked(contactId:string):Promise<SupersededCleanupResult> {
  const result:SupersededCleanupResult={contactId,batches:0,blocked:false,reason:null};
  const pending=await this.storage.execute<SupersededPending>('history.supersededPending',{ownerId:this.ownerId});
  for(const operation of pending.operations.filter(op=>op.contactId===contactId)){
   const state=await this.advance(operation.operationId);
   if(state!=='completed'){result.blocked=true;result.reason=state;return result;}
   result.batches++;await this.notify(contactId);
  }
  for(let batch=0;batch<(this.options.maxBatches??200)&&!this.closed;batch++){
   const preview=await this.storage.execute<SupersededPreview>('history.supersededPreview',{ownerId:this.ownerId,contactId});
   if(!preview.work){result.reason=preview.gate;break;}
   let operationId:string;
   try{
    operationId=(await this.deletion.plan({ownerId:this.ownerId,requestKey:`history.superseded.${contactId}.${randomUUID()}`,scope:{kind:'superseded_history',contactId}})).operationId;
   }catch(error){
    // 预览与计划之间条件变化（围栏、修复或删除开始）：不是错误，等条件解除后再清。
    if(error instanceof StorageFailure&&error.code.startsWith('superseded_cleanup_')){result.reason=error.code.slice('superseded_cleanup_'.length);break;}
    throw error;
   }
   const state=await this.advance(operationId);
   if(state!=='completed'){result.blocked=true;result.reason=state;return result;}
   result.batches++;await this.notify(contactId);
  }
  await this.storage.execute('history.supersededResolve',{ownerId:this.ownerId,contactId});
  return result;
 }
 private async notify(contactId:string):Promise<void> {
  try{await this.options.changed?.(contactId);}catch{/* 界面刷新失败不回滚已完成的清理。 */}
 }
}
