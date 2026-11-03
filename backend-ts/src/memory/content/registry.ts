import type {Context} from '@deepseek-ai/cordis';
import type {StorageRow,StorageTransaction} from '../../storage/sqlite/contracts.ts';
import {StorageFailure} from '../../storage/sqlite/contracts.ts';
import type {ExtractionMessage} from '../extraction/protocol.ts';
import type {ExtractionInvocation} from '../extraction/flow.ts';

export interface FrozenMemoryContent {
 pluginId:string;pluginVersion:string;kind:string;identity:Record<string,unknown>;
}
export interface MemoryContentScope {ownerId:string;contactId:string;message:StorageRow}
export interface MemoryContentBatchScope {ownerId:string;contactId:string;messages:readonly StorageRow[]}
export interface MemoryContentResources {
 readImage(input:{contactId:string;messageId:string;fileId:string;sha256:string;mediaGeneration:string;mimeType:string;byteSize:number;signal:AbortSignal;requireCurrent():Promise<void>}):Promise<{mimeType:string;dataBase64:string}>;
}
export interface PreparedMemoryContent {message:ExtractionMessage;images?:ExtractionInvocation['images']}
/** 内容插件仅解释同一联系人的消息；调度判断可用性，执行时再冻结，不调模型或写记忆。 */
export interface MemoryContentPlugin {
 id:string;version:string;kinds:readonly string[];
 /** 组批前声明原始输入占用；文字与转换后的协议开销仍由正式模型预算复核。 */
 modelInputCost(identity:Record<string,unknown>):{images:number;bytes:number};
 snapshot(tx:StorageTransaction,scope:MemoryContentScope):Record<string,unknown>|null;
 /** 调度只判定当前内容可用性，不冻结正文、计算摘要或准备模型输入。 */
 availableMany?(tx:StorageTransaction,scope:MemoryContentBatchScope):ReadonlySet<string>;
 prepare(input:MemoryContentScope&{frozen:FrozenMemoryContent;resources?:MemoryContentResources;signal:AbortSignal;requireCurrent():Promise<void>}):Promise<PreparedMemoryContent>;
}
export class MemoryContentRegistry {
 private readonly plugins=new Map<string,MemoryContentPlugin>();
 register(plugin:MemoryContentPlugin):()=>void {
  if(!/^[a-z][a-z0-9.-]{0,95}$/.test(plugin.id)||!plugin.version||!plugin.kinds.length||this.plugins.has(plugin.id)
   ||[...this.plugins.values()].some(other=>other.kinds.some(kind=>plugin.kinds.includes(kind))))throw new StorageFailure('memory_content_plugin_conflict');
  this.plugins.set(plugin.id,plugin);return ()=>{if(this.plugins.get(plugin.id)===plugin)this.plugins.delete(plugin.id);};
 }
 get kinds():string[]{return [...this.plugins.values()].flatMap(plugin=>[...plugin.kinds]);}
 snapshot(tx:StorageTransaction,scope:MemoryContentScope):FrozenMemoryContent|null {
  const plugin=[...this.plugins.values()].find(plugin=>plugin.kinds.includes(String(scope.message.kind)));
  if(!plugin)return null;const identity=plugin.snapshot(tx,scope);
  return identity===null?null:{pluginId:plugin.id,pluginVersion:plugin.version,kind:String(scope.message.kind),identity};
 }
 availability(tx:StorageTransaction,scope:MemoryContentBatchScope):ReadonlySet<string> {
  const available=new Set<string>();
  for(const plugin of this.plugins.values()){
   const messages=scope.messages.filter(message=>plugin.kinds.includes(String(message.kind)));
   for(let offset=0;offset<messages.length;offset+=500){
    const batch=messages.slice(offset,offset+500);
    if(plugin.availableMany){
     const accepted=plugin.availableMany(tx,{...scope,messages:batch});
     for(const message of batch)if(accepted.has(String(message.id)))available.add(String(message.id));
    }else{
     // 未升级的自定义插件继续收到完整消息；内置调度路径不读取正文。
     const rows=tx.all('SELECT * FROM message WHERE owner_id=? AND contact_id=? AND id IN (SELECT value FROM json_each(?))',
      [scope.ownerId,scope.contactId,JSON.stringify(batch.map(message=>String(message.id)))]);
     const byId=new Map(rows.map(row=>[String(row.id),row]));
     for(const message of batch){
      const row=byId.get(String(message.id));
      if(row&&plugin.kinds.includes(String(row.kind))&&plugin.snapshot(tx,{ownerId:scope.ownerId,contactId:scope.contactId,message:{...message,...row}})!==null)available.add(String(message.id));
     }
    }
   }
  }
  return available;
 }
 require(frozen:FrozenMemoryContent):MemoryContentPlugin {
  const plugin=this.plugins.get(frozen.pluginId);
  if(!plugin||plugin.version!==frozen.pluginVersion||!plugin.kinds.includes(frozen.kind))throw new StorageFailure('memory_content_plugin_unavailable');return plugin;
 }
 async prepare(input:Parameters<MemoryContentPlugin['prepare']>[0]):Promise<PreparedMemoryContent>{
  input.signal.throwIfAborted();await input.requireCurrent();
  const result=await this.require(input.frozen).prepare(input);input.signal.throwIfAborted();await input.requireCurrent();return result;
 }
}
/** 通过官方 Cordis 插件生命周期注册；卸载后不继续使用旧插件。 */
export const memoryContentPlugin={name:'notalone-memory-content',apply(ctx:Context,config:{registry:MemoryContentRegistry;plugins:readonly MemoryContentPlugin[]}){
 for(const plugin of config.plugins)ctx.effect(()=>config.registry.register(plugin));
}};
