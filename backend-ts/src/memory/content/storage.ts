import type {StorageRegistry,StorageTransaction,StorageLease} from '../../storage/sqlite/contracts.ts';
import {MemoryContentRegistry,type MemoryContentPlugin} from './registry.ts';
import {withMemoryContentRegistry} from '../sqlite/content.ts';
/** 受信任的 Worker 装配入口；与宿主共用插件模块，不接受 renderer/HTTP 注入代码。 */
export function createMemoryContentStorageRegistry(base:StorageRegistry,plugins:readonly MemoryContentPlugin[]):StorageRegistry {
 const registry=new MemoryContentRegistry();for(const plugin of plugins)registry.register(plugin);
 return {...base,actions:base.actions.map(action=>action.mode==='maintenance'?action:{...action,
  execute:(tx:StorageTransaction,input:unknown,lease:StorageLease)=>withMemoryContentRegistry(registry,()=>action.execute(tx,input,lease)),
 })};
}
