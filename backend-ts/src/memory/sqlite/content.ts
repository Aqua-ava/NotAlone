import type {StorageRow,StorageTransaction} from '../../storage/sqlite/contracts.ts';
import {StorageFailure} from '../../storage/sqlite/contracts.ts';
import {createBuiltinMemoryContentRegistry} from '../content/builtins.ts';
import type {FrozenMemoryContent} from '../content/registry.ts';
import type {MemoryContentRegistry} from '../content/registry.ts';
import {AsyncLocalStorage} from 'node:async_hooks';
const builtinRegistry=createBuiltinMemoryContentRegistry();
const scopes=new AsyncLocalStorage<MemoryContentRegistry>();
const registry=()=>scopes.getStore()??builtinRegistry;
export const installedMemoryContentKinds=()=>registry().kinds;
/** Worker 与宿主由同一可信插件清单装配；嵌套的基础 registry 不覆盖外层装配。 */
export function withMemoryContentRegistry<T>(value:MemoryContentRegistry,work:()=>T):T{return scopes.getStore()?work():scopes.run(value,work);}
export const hasMemoryContent=(tx:StorageTransaction):boolean=>!!tx.get("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='run_content_input'");
export function currentContent(tx:StorageTransaction,ownerId:string,contactId:string,message:StorageRow):FrozenMemoryContent|null {
 return registry().snapshot(tx,{ownerId,contactId,message});
}
/** 调度与页面统计使用批量可用性，完整内容冻结仍沿原 snapshot 复验。 */
export function currentContentAvailability(tx:StorageTransaction,ownerId:string,contactId:string,messages:readonly StorageRow[]):ReadonlySet<string> {
 return registry().availability(tx,{ownerId,contactId,messages});
}
export function freezeContent(tx:StorageTransaction,ownerId:string,runId:string,inputNo:number,frozen:FrozenMemoryContent):void {
 if(!hasMemoryContent(tx))return;
 tx.run('INSERT INTO run_content_input VALUES(?,?,?,?,?,?,?)',[ownerId,runId,inputNo,frozen.pluginId,frozen.pluginVersion,frozen.kind,JSON.stringify(frozen.identity)]);
}
export function readFrozenContent(tx:StorageTransaction,ownerId:string,input:StorageRow):FrozenMemoryContent|null {
 if(!hasMemoryContent(tx))return null;
 const row=tx.get('SELECT * FROM run_content_input WHERE owner_id=? AND run_id=? AND input_no=?',[ownerId,input.run_id,input.input_no]);
 return row?{pluginId:String(row.plugin_id),pluginVersion:String(row.plugin_version),kind:String(row.content_kind),identity:JSON.parse(String(row.identity_json))}:null;
}
export function assertFrozenContent(tx:StorageTransaction,ownerId:string,input:StorageRow,message:StorageRow):void {
 const frozen=readFrozenContent(tx,ownerId,input);
 // 迁移前的文字输入仍沿原文字合同，旧媒体输入不猜测补证。
 if(!frozen){if(message.kind!=='text')throw new StorageFailure('memory_content_source_stale');return;}
 registry().require(frozen);const actual=currentContent(tx,ownerId,String(input.source_contact_id),message);
 if(!actual||JSON.stringify(actual)!==JSON.stringify(frozen))throw new StorageFailure('memory_content_source_stale');
}
export function contentRows(tx:StorageTransaction,ownerId:string,rows:StorageRow[]):StorageRow[]{
 return rows.map(row=>{const frozen=readFrozenContent(tx,ownerId,row);return {...row,...(frozen?{content_kind:frozen.kind,plugin_id:frozen.pluginId,plugin_version:frozen.pluginVersion,identity_json:JSON.stringify(frozen.identity)}:{})};});
}
/** 目标优先形成有界小批；上下文只在剩余额度中选取，不能挤掉全部目标。 */
export function boundContentInputs(tx:StorageTransaction,ownerId:string,targets:StorageRow[],context:StorageRow[]):{targets:StorageRow[];context:StorageRow[]}{
 let images=0,bytes=0;
 const fits=(row:StorageRow)=>{
  const frozen=readFrozenContent(tx,ownerId,row),cost=frozen?registry().require(frozen).modelInputCost(frozen.identity):{images:0,bytes:0};
  if(!Number.isSafeInteger(cost.images)||cost.images<0||!Number.isSafeInteger(cost.bytes)||cost.bytes<0)throw new StorageFailure('memory_content_budget_invalid');
  if(images+cost.images>8||bytes+cost.bytes>32*1024*1024)return false;
  images+=cost.images;bytes+=cost.bytes;return true;
 };
 const selected:StorageRow[]=[];
 for(const row of targets){if(!fits(row))break;selected.push(row);}
 if(targets.length&&!selected.length)throw new StorageFailure('memory_content_input_too_large');
 return {targets:selected,context:context.filter(fits)};
}
