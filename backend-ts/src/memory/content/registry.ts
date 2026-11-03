import type {Context} from '@deepseek-ai/cordis';
import type {StorageRow,StorageTransaction} from '../../storage/sqlite/contracts.ts';
import {StorageFailure} from '../../storage/sqlite/contracts.ts';
import type {ExtractionMessage} from '../extraction/protocol.ts';
import type {ExtractionInvocation} from '../extraction/flow.ts';

export interface FrozenMemoryContent {
 pluginId:string;pluginVersion:string;kind:string;identity:Record<string,unknown>;
}
export interface MemoryContentScope {ownerId:string;contactId:string;message:StorageRow}
export interface MemoryContentResources {
 readImage(input:{contactId:string;messageId:string;fileId:string;sha256:string;mediaGeneration:string;mimeType:string;byteSize:number;signal:AbortSignal;requireCurrent():Promise<void>}):Promise<{mimeType:string;dataBase64:string}>;
}
export interface PreparedMemoryContent {message:ExtractionMessage;images?:ExtractionInvocation['images']}
/** 插件只解释已冻结的单条消息；不挑选联系人、不调模型、不写记忆。 */
export interface MemoryContentPlugin {
 id:string;version:string;kinds:readonly string[];
 /** 组批前声明原始输入占用；文字与转换后的协议开销仍由正式模型预算复核。 */
 modelInputCost(identity:Record<string,unknown>):{images:number;bytes:number};
 snapshot(tx:StorageTransaction,scope:MemoryContentScope):Record<string,unknown>|null;
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
